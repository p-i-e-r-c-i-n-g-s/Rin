# blog.pearcache.com (Rin fork)

Forked from [openRin/Rin](https://github.com/openRin/Rin). One Cloudflare Worker
(`rin-server`) serving a React SPA plus a Hono API, on D1 + R2 + Workers AI +
Queues.

## The fork is deliberate — do not "de-fork" it

Considered and rejected 15 Sep 2026. The proposal was to strip the fork,
rebuild a minimal blog, and credit upstream, on the theory that the ~1,656
lockfile entries were a supply-chain surface the fork imposed. They are not:
React, Hono, Drizzle, the markdown pipeline and mermaid are the *stack*, not
the fork, and a rebuild keeps almost all of them. What a rebuild does lose is
upstream's security fixes, in exchange for hand-written code that nobody has
read yet. The three defects found in the audit were all fixable in ~100 lines
(see below) against weeks for a rewrite.

The repo already carries local customisations (terminal header, "posts"
naming). Keep them as commits on top so upstream stays mergeable.

## Every response goes through `handleFetch` — this is the useful property

`server/src/runtime/fetch-handler.ts` routes API, static assets and the SPA
entry itself. There is **no asset-store-first bypass** here (unlike
ears-pearcache, where a path matching a file in `site/` never reaches the
Worker at all). So one wrapper covers everything, and `SECURITY_HEADERS` is
applied in exactly one place.

`env.ASSETS.fetch()` returns an **immutable** response — headers must be copied
into a `new Response`, not mutated. That is why `withSecurityHeaders` rebuilds
rather than sets.

## Security audit — 15 Sep 2026

### DISMISSED — "unauthenticated stored XSS in guest comments". Not real.

Recorded because it was reported as critical and was wrong, and the reasoning
that produced it is seductive enough to be repeated.

The claim chained three true facts into a false conclusion: guest comments need
no auth (true), `client/src/components/markdown.tsx` renders through
`rehypeRaw` with `rehype-sanitize` installed-but-never-imported (true), and
therefore comment content reaches raw HTML (**false**).

Comment content is rendered at `client/src/page/feed.tsx` as:

    <p className="...">{comment.content}</p>

A JSX text child. React escapes it. The `<Markdown>` component is used by
`feed.tsx:285` (post body), `moment_item.tsx:79` and the editor preview —
**never by comments**. Post and moment bodies are admin-authored, so `rehypeRaw`
there is a deliberate feature (the admin wants raw HTML in their own posts),
the same category as `footer.tsx`'s `innerHTML`.

`rehype-sanitize` sitting unused in `package.json` is therefore untidy, not a
vulnerability. **Verify the render site before believing a plugin list.**

### REAL, FIXED — `javascript:` URI injection via `guestWebsite`

The genuine defect in the same feature, and much narrower: an anonymous
commenter could store any string as their website, and it was rendered into
`href={comment.guestWebsite}` (`feed.tsx:614`). `javascript:fetch('https://…'
+ localStorage.token)` executes on click. React 18 logs a warning for a
`javascript:` href and renders it anyway.

`<input type="url">` on the form is a UX hint only — a direct POST to
`/api/comment/:feed` never sees it. Validation belongs on the server.

**Fixed** with `safeWebsite()` in `server/src/services/comments.ts`,
allowlisting `http:`/`https:`. Applied on **write and on read** — the read-path
call is what neutralises rows already in D1 from before the fix, so do not
"simplify" it away as duplication.

It parses with `new URL()` rather than matching a regex on purpose: `URL`
lowercases the scheme and strips the tab/newline padding (`java\tscript:`)
exactly as a browser does when resolving an href, so validation and execution
cannot disagree about what the string means. A schemeless `example.com` gets
`https://` prepended rather than being dropped.

### REAL, FIXED — guest email addresses were published to everyone

`GET /api/comment/:feed` returned `guestEmail` for every guest comment, so any
reader could harvest the address of everyone who had ever commented. Now
dropped from the response and kept in the DB for the admin's webhook only.

### REAL, FIXED — no security headers at all

No `_headers` file, nothing set in the Worker. Now in `SECURITY_HEADERS`.

**`script-src 'self'` carries no `'unsafe-inline'` and no `'unsafe-eval'`, and
that is verified, not assumed:** the built `index.html` has two external
same-origin scripts and zero inline ones, and a scan of every built chunk for
`new Function(`/`eval(` returns only two hits, both inside Prism
*syntax-highlighting grammars* that list `eval` as a language keyword. Mermaid
— the usual reason an app needs `unsafe-eval` — has none. The whole app shell
was loaded from the real build under the real headers on a local harness:
renders fully, zero console violations.

`style-src` does keep `'unsafe-inline'`: react-syntax-highlighter and the
lightbox set `style=""` attributes at runtime. Inline CSS cannot execute
script, so this is a far smaller concession than the script-src equivalent.

**The one thing this breaks:** `footer.tsx` deliberately re-executes
admin-authored `<script>` tags from the custom-footer setting. Under
`script-src 'self'` an inline snippet there will not run. If you add analytics
that way, add its origin to the directive — do **not** add `'unsafe-inline'`,
which would gut the policy. `fetch-handler.test.ts` asserts that and goes red.

### REAL, FIXED — `approved` was dead schema

`comments.approved` defaulted to 1, was written once, and **the read path never
filtered on it** (`where: eq(comments.feedId, feedId)`, nothing else). There was
no approve endpoint either. So moderation did not exist, and flipping the
default alone would have black-holed every guest comment with no way to release
it — worse than not moderating.

Now: guest comments insert `approved: 0` unless `comment.guest.approval` is
`false`; the list filters to approved for everyone except admins (who see
pending ones so there is something to act on); `POST /:id/approve` is admin-only
and mirrors the existing delete route's gate.

`requiresApproval()` **fails closed** — a config read that throws returns
`true`. A config lookup that errors must not silently start auto-publishing.

### REAL, FIXED — unauthenticated writes were unbounded

`POST /api/comment/:feed` checked only that `content` was non-empty, so one
anonymous request could store an arbitrarily large row in D1. Capped at
`MAX_CONTENT` (10,000) and `MAX_FIELD` (200).

### REAL, FIXED 23 Sep 2026 — `/blob/*` was unscoped

`getStorageObject` passed the key straight to the bucket with no folder
scoping, so it was not limited to `S3_FOLDER` (`images/`). Unauthenticated.
It was worse than this note first said: the key was also pasted into the S3
URL unescaped, so `/api/blob/%3Flist-type%3D2` became a signed ListObjectsV2
on the whole bucket. Fixed in #19; see "Pre-public fixes" at the end of this
file. Still: **never put anything private in `pearcache-images`**, because
`images.pearcache.com` serves the bucket publicly anyway.

### REAL, FIXED — upload parsed before it authenticated

`server/src/services/storage.ts` called `parseBody()` *then* checked
`if (!uid) return 401`, so an anonymous request got its whole multipart body
buffered before being refused. The auth check now runs first.

`key` and `file` were also asserted (`body.key as string`) rather than checked,
so a malformed multipart body reached `key.includes(...)` and threw an uncaught
`TypeError` **outside** the `try` below it — a 500 where 400 is correct. Both
are validated now.

### REAL, FIXED — the comment switches were decorative

`comment.enabled` and `comment.guest.enabled` were read **only** by the client
(`feed.tsx:538` and `:372`), where they decide whether the form is drawn.
`POST /api/comment/:feed` checked neither. Turning comments off in Settings
hid the form and left the endpoint accepting anything posted straight at it.

This is the same shape as the `<input type="url">` that `safeWebsite()` had to
re-check: **a control that only moves the UI is not a control.** When you find
one config key read in the client, grep the server for it before believing it
does anything.

Both are enforced in `comments.ts` now and both **default to false** — comments
are off unless deliberately switched on — and both fail closed if the config
read throws. The client's guest default was flipped to match; it had been the
opposite, offering a form the server would now refuse.

Note the server default is the authority. `server/src/services/__tests__/comments.test.ts`
switches both on in `beforeEach`, because those tests are about what happens
once comments are enabled.

### Credentials

Five secrets are set on `rin-server` (`ADMIN_PASSWORD`, `ADMIN_USERNAME`,
`JWT_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). Username/password is
the **only** login path — GitHub OAuth is not configured.

`.env.example` documents the upstream defaults `admin`/`admin123`, and
`config-health.ts:71` has a check for exactly that pair, i.e. upstream treats
it as a live hazard. **Confirmed changed from the defaults, 15 Sep 2026.**
Credentials were never tested from a session — that is the owner's word, and
the right way round.

No secrets found in git history across the repo.

### GitHub OAuth — supported in code, needs no change, but has one trap

`RIN_GITHUB_CLIENT_ID` + `RIN_GITHUB_CLIENT_SECRET` as Worker secrets is all it
takes; `hono-middleware.ts:81` builds the provider when both are present and
leaves `oauth2` undefined otherwise. Scope is `read:user`. The callback route is
`GET /user/github/callback` on the Hono app, which is mounted under `/api`, so
the URL GitHub must be given is **`https://blog.pearcache.com/api/user/github/callback`**.

**The trap is `user.ts:118`.** A GitHub login gets `permission: 0` unless the
`users` table is **empty**, in which case it gets `permission: 1`. The
password admin **is** a row (`auth.ts` inserts `openid: "admin"`,
`permission: 1` on first successful password login), so on an existing blog the
table is not empty and **signing in with GitHub produces an ordinary user, not
an admin.** Promote it in D1 afterwards.

Corollary worth knowing: there is no allowlist. Any GitHub account can sign in
and get a `permission: 0` row. That is low risk — such a user can comment (and
comments are off) and delete their own comments, nothing else — but it is not
"only I can log in".

## Dependabot review — 15 Sep 2026 (7 alerts: 1 high, 4 moderate, 2 low)

One upgrade taken, one alert that is genuinely reachable and **not** fixed here,
two that are not reachable at all, and one CI gate found to be decorative.

`bun pm view` reports `drizzle-kit` latest as 0.31.10, so "fifteen minor
versions behind" is about right for the orm; the kit had drifted further.

### DISMISSED as unreachable, then upgraded anyway — drizzle-orm GHSA-gpj5-g38j-94v9

CVE-2026-39356, High, `< 0.45.2`. The advisory is **not** about values: it is
that `escapeName()` wrapped an identifier in quotes without doubling an
embedded quote, so untrusted input reaching `sql.identifier()`, `.as()`, a
dynamic alias or a CTE name can terminate the identifier and inject SQL.
Its own "Affected components" note says applications using only static schema
objects are unaffected.

**This codebase has no such sink.** Across 229 `.ts`/`.tsx` files outside
`node_modules`, `sql.identifier`, `.as(`, `alias(`, `$with` and `sql.raw`
return **zero** matches. The grep was proved able to find things first — the
same pipeline returns 23 files for `drizzle-orm` and 9 for `orderBy`. All 16
`orderBy` call sites name a hardcoded column — every one of them contains a
literal `desc(` or `asc(` on a schema column (`desc(feeds.createdAt)` and
friends), with no line left over. `sql` is imported in exactly one file,
`db/schema.ts`, for two constant ``sql`(unixepoch())` `` defaults.

The only untrusted string that reaches a query is the search keyword
(`GET /search/:keyword` → `searchFeedPage`). Compiled with `.toSQL()` against
the real schema on 0.30.10, it lands in **bound parameters**:

    ... where (("feeds"."title" like ? or "feeds"."content" like ? ...))
    params: ["%x\" , (SELECT group_concat(name) FROM sqlite_master) AS \"z%", ...]

Static identifiers, payload confined to `?`. A positive control in the same
run proved the sink really is broken in the version this repo shipped —
`sql.identifier()` with the same payload emitted

    order by "x" , (SELECT group_concat(name) FROM sqlite_master) AS "z"

which is live injection. On 0.45.2 the identical call emits

    order by "x"" , (SELECT group_concat(name) FROM sqlite_master) AS ""z"

one inert quoted identifier. So the library flaw was real and present, and the
app never handed it anything. **Verified by running the query builder, not by
reading the call sites** — this repo has already been burned once by a finding
reasoned from a plugin list rather than a render site.

Upgraded regardless: it removes a footgun for whoever adds dynamic sorting
next, which is exactly the feature the advisory names.

### The drizzle upgrade: 50 type errors that had nothing to do with drizzle

PR #3 deferred this after measuring 0.45.2 turning `bun run check` from 0 to 50
errors. Reproduced exactly: 28× `Cannot find module 'bun:test'`, 16× `bun:sqlite`,
3× `global`, 2× `process`, 1× `Error.captureStackTrace`. **None mention
drizzle's API.**

`server/tsconfig.json` sets `"types": ["./worker-configuration.d.ts"]`, and
naming `types` at all is an allowlist that switches off automatic `@types`
inclusion. Bun's ambient types were never declared — they arrived as a side
effect of drizzle 0.30's own `.d.ts` files referencing `bun-types`. 0.45 stopped
referencing them, so the ambient declarations vanished. The upgrade did not
break the types; it removed an accidental prop.

**Fix is one entry:** `"bun"` added to that `types` array. `@types/bun` was
already a devDependency, so nothing new was installed. Do not remove it —
`bun run check` goes red.

**`drizzle-kit` had to move too.** 0.21.4 refuses to run against orm 0.45.2 and
exits 1 (`This version of drizzle-kit is outdated`), which breaks
`bun run db:generate`. Bumped to ^0.31.10, which reads the schema and reports
all 11 tables with their indexes and fks — incidentally a second, independent
confirmation that the schema's object-returning extras callbacks
(`(table) => ({ ... })`, eight of them) are still honoured in 0.45 and needed
no migration.

**Trap: `drizzle-kit generate` output is not this repo's migration path.** It
writes `server/drizzle/`, which does not exist and is in no ignore list, and it
generated a from-scratch `0000_*.sql` because it has no knowledge of the 13
hand-written migrations in `server/sql/` that the CLI actually applies. That
output was deleted, not committed. If you run `db:gen`, throw the result away
or you will have two migration lineages and only one of them runs.

### REACHABLE, shipped — i18next-http-backend GHSA-q89c-q3h5-w34g (fixed, see below)

The only one of the six non-drizzle alerts that touches deployed code with
attacker-influencable input, and the reason "dev tooling, therefore harmless"
is not a safe default answer.

`i18next-http-backend@2.5.2` (vulnerable `< 3.0.5`) is a **runtime dependency**
of `client`, and is present in the built client bundle. `client/src/app/bootstrap.ts`
uses the exact vulnerable shape:

    backend: { loadPath: "/locales/{{lng}}/{{ns}}.json" }
    .use(LanguageDetector)          // no `detection` option -> defaults apply

The installed detector's default order is
`['querystring', 'cookie', 'localStorage', 'sessionStorage', 'navigator', 'htmlTag']`
with `lookupQuerystring: 'lng'` — **querystring first**, so `?lng=` is the
highest-priority source. The backend then does
`services.interpolator.interpolate(loadPath, { lng, ns })` with no encoding and
no normalisation. Resolved the way a browser resolves a relative `fetch`:

    ?lng=en                  -> /locales/en/translation.json
    ?lng=../..               -> /translation.json            (escapes /locales/)
    ?lng=../../api/comment/1 -> /api/comment/1/translation.json

**Bounded, though.** Because `loadPath` starts with a literal `/locales/`, no
payload tried produced an off-origin URL — this is same-origin path confusion,
not remote script loading. Weaponising it needs a same-origin endpoint serving
attacker-controlled JSON shaped like a translation map; `/api/comment/:feed`
returns an array, so a victim mostly gets missing keys. Worth noting
`interpolation: { escapeValue: false }` is set, which is normal under React but
removes one incidental mitigation.

**Fixed** — see "The two client alerts" below. Both halves: the version bump,
and an allowlist that closes it independently of the version.

### NOT REACHABLE — @cloudflare/vite-plugin GHSA-4pfg-2mw5-f8jx

Moderate, `< 1.6.0`, "exposes secrets over the built-in dev server". The plugin
is a devDependency of `client` at `^0.1.1` and is **never imported**: across 400
non-`node_modules` files it appears only in `client/package.json`.
`client/vite.config.ts` loads `react()` and `visualizer()` and nothing else, so
the plugin's dev server never runs. Positive control: the same grep finds
`@vitejs/plugin-react-swc` in both `package.json` and `vite.config.ts`.

Zero occurrences in the deployed worker bundle.

**The right fix is deletion, not a 0.1 → 1.6 major upgrade.** It is dead weight
that costs a recurring alert. **Deleted** — see below.

### NOT REACHABLE — turbo GHSA-hcf7-66rw-9f5r (moderate) and GHSA-3qcw-2rhx-2726 (low)

Four alerts, not four problems: two advisories × two directories, because
`turbo` is declared in both root `package.json` and `client/package.json` at
`^1.13.3` (1.13.4 installed, in range for both).

- **Login callback CSRF/session fixation** needs `turbo login` to be run. There
  is no `turbo login` or `turbo link` anywhere in the repo, no `remoteCache`
  or `teamId` in `turbo.json`, and no `.turbo/config.json`. No remote cache is
  configured, so the login flow is never exercised.
- **Local code execution during Yarn Berry detection** needs Yarn Berry. There
  is no `.yarn/`, no `.yarnrc.yml`, no `.pnp.cjs` and no `yarn.lock`; the only
  lockfile is `bun.lock` and `packageManager` is `bun@1.3.13`. Both are
  local-developer risks in any case, not site risks.

Verified against the built artifacts rather than argued from `devDependencies`:
the deployed worker (`dist/server/_worker.js`) contains **0** occurrences of
`turbo`, `i18next` and `vite-plugin`, and 217 of `drizzle`. The client bundle's
three `turbo` hits are `gpt-4-turbo`, `gpt-3.5-turbo` and `glm-3-turbo` in an
AI model list — a substring, not the build tool.

Turbo does emit a real warning on every run —
`could not resolve workspaces: unable to parse ... "client@^workspace:client"` —
because turbo 1.13 tries to read `bun.lock` with its yarn-lockfile parser. It
is noisy and unrelated to either advisory; turbo 2.x is where that is fixed.

### `bun run format:check` is a gate that cannot fail

Found while establishing a baseline. `format:check` is declared in
`turbo.json`'s pipeline and in root `package.json` as `turbo format:check`, but
**no workspace defines the script**, so it resolves to nothing:

    Tasks:    0 successful, 0 total
    exit 0

`ci.yml` runs it as one of its two gates. It has never checked formatting and
cannot report a failure — the exact shape this account has been bitten by
before (a skipped job rendering green). PR #3's description cites
"`bun run format:check` exits 0" as evidence; it exits 0 unconditionally.
Either give a workspace a real `format:check` script or drop the gate, but do
not read it as formatting having been verified.

### How this change was verified

Every number below is from a run on this branch, rebased onto `343837c`.
`bun run check` is always `--force`, because turbo will otherwise replay a
cached green (`FULL TURBO`) and a cached pass is not a run.

| gate | before | after |
|---|---|---|
| `bun run check --force` | exit 0, 0 TS errors | exit 0, 0 TS errors |
| `bun run test:server` | 319 pass / 0 fail | **319 pass / 0 fail** |
| `bun run test:client` | 32 pass / 0 fail | 32 pass / 0 fail |
| `bun run check` in `server/` | exit 0 | exit 0 |
| `bun run build:server` | exit 0 | exit 0 |

Note the baseline was taken twice. Measured first against `755b51b`, where the
server suite is **308** tests; PR #5 merged mid-change and took main to
`343837c`, where it is **319**. If a future session reads a count here that
does not match, check which commit main is on before assuming a test was lost.

Local bun is 1.4.0; `ci.yml` pins 1.3.13. Nothing observed depended on the
difference, and CI has since confirmed it — see the CI section below; `CI`,
`CI - Test and Type Check` and `Build` all pass on the pinned 1.3.13.


## The two client alerts — 16 Sep 2026

Follow-up to the review above. Closes the two remaining Dependabot alerts that
land on `client`, and they are closed in opposite ways: one needed a real
control, the other needed a deletion.

### `supportedLngs` is a security control here, not a preference

`i18next-http-backend` is now `^3.0.5` (resolved 3.0.6), which closes
GHSA-q89c-q3h5-w34g. **The bump is the lesser half of this change.** The
allowlist is the part that holds, and it holds whatever version is installed:

    supportedLngs: [...SUPPORTED_LNGS]      // client/src/app/bootstrap.ts

Measured, with a control first — without the allowlist, i18next really does ask
the backend for the traversing code, and with it it does not:

| detected `?lng=` | before: languages requested | after |
|---|---|---|
| `en` | `["en"]` | `["en"]` |
| `zh-CN` | `["zh-CN","zh","en"]` | `["zh-CN","en"]` |
| `en-US` | `["en-US","en"]` | `["en"]` |
| `ja-JP` | `["ja-JP","ja","en"]` | `["ja","en"]` |
| `../..` | **`["../..","en"]`** | `["en"]` |

Two things worth reading off that table. Every locale the site ships still
loads, so this is not a filter that quietly breaks Japanese. And it *removes*
requests: `en-US` and `ja-JP` used to 404 on the way to their base language and
now collapse straight onto it.

`zh` and `zh-Hant-TW` now resolve to `en` without first 404ing on `zh` /
`zh-Hant`. Same outcome as before, one less request — but note it *is* the same
outcome: a Traditional-Chinese browser announcing `zh-Hant-TW` gets English, not
`zh-TW`, and always did. That is a pre-existing gap in the locale files, not
something this change introduced, and `nonExplicitSupportedLngs` would not fix
it either (it would re-admit `en-US` to the request path instead).

### The locale list is in one file because two would drift silently

`client/src/app/locales.ts` is new and holds `LOCALES` / `SUPPORTED_LNGS`.
Before this, the language menu's list was a `const` inside `LanguageSwitch`
in `action-buttons.tsx`; the allowlist would have been a second copy.

That is the failure shape this repo keeps meeting — the `<input type="url">`
that `safeWebsite()` had to re-check, and the comment switches that only moved
the UI. Two lists here fail **silently in both directions**: add a locale to the
menu only and you ship a button that requests a file the allowlist blocks; add
it to the allowlist only and you ship a locale nobody can select. Neither throws.

`locales.test.ts` asserts the list equals the directories actually present in
`client/public/locales`, in both directions, so the drift is a red test rather
than a dead menu item.

### The security test carries its own control

`locales.test.ts` has four cases, and the first one is the important one:

    CONTROL: without the allowlist, the traversing code does reach the backend

Without that, "no traversing request was made" would pass just as happily if
i18next ever stopped requesting unknown codes for some unrelated reason — a
check that cannot fail, asserting nothing. The control fails if the probe stops
being able to observe the thing it is testing.

The backend stub records the language it is asked for instead of fetching, so
this observes i18next's real resolution path rather than re-asserting the config.

### `@cloudflare/vite-plugin` deleted, not upgraded

GHSA-4pfg-2mw5-f8jx was a moderate on a `0.1.1` devDependency that **nothing
imported** — it appeared only in `client/package.json`. Upgrading 0.1 → 1.6 to
close an alert on a package that never loads is worse than removing it.

Removing it dropped **223 lines from `bun.lock`**, so it was not one package but
a tree of them. `client/vite.config.ts` is unchanged and still builds — it loads
`react()` and `visualizer()` and never referenced the plugin.

Note `bun install` leaves the stale `node_modules/@cloudflare/vite-plugin`
directory behind; it is gone from the lockfile, which is what CI installs from
and what Dependabot reads. Do not take the leftover directory as the removal
having failed.

### Verified

Gates, on the stacked branch, `check` always `--force`:

| gate | result |
|---|---|
| `bun run check --force` | exit 0, 0 TS errors |
| `bun run test:client` | **38 pass / 0 fail** (32 before, +6 new) |
| `bun run test:server` | 319 pass / 0 fail |
| `bun run build` in `client/` | exit 0 |

And confirmed in the built artifact rather than the source, because that is the
thing that ships: `dist/client/assets/index-*.js` contains
`supportedLngs:[...sBe]` where `sBe=Uxe.map(({code:i})=>i)` — the shared list,
minified — with all four codes present, and **zero** occurrences of
`@cloudflare/vite-plugin`.

The remaining four open alerts are turbo's, and the section above says why none
of them is reachable. Closing them means turbo 1 → 2, which is a build-tool
major with no security exposure behind it — worth doing on its own schedule, not
as a security fix.

## CI had never run on this fork — fixed 16 Sep 2026

Found while checking the PRs for the Dependabot work above, and **resolved**.
Before the fix, no workflow in `.github/workflows/` had ever executed:

| workflow | state | runs, all time (before) |
|---|---|---|
| `CI` (`ci.yml`) | active | **0** |
| `CI - Test and Type Check` (`test.yml`) | active | **0** |
| `Build` (`build.yml`) | active | **0** |
| `Deploy` (`deploy.yml`) | active | **0** |

The repository's entire Actions history was **2 runs**, both GitHub-managed
`Dependabot Updates`. #3 and #5 merged without CI.

### What fixed it: toggling repository Actions off and on

    gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false
    gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true -f allowed_actions=all

The next `pull_request` event after that produced runs immediately — `CI`,
`CI - Test and Type Check` and `Build` all fired on #6 and all three passed.
Nothing else changed: same workflow files, same branches, same triggers.
Whatever state was suppressing run creation, that toggle cleared it.

### Why none of the obvious checks found it

This is the part worth keeping, because **every surface GitHub exposes said
Actions were healthy** while no run was being created:

- `gh workflow list` reported every workflow `active` — not `disabled_fork`,
  which is the state the fork gate actually produces.
- `GET /actions/permissions` returned `{"enabled": true, "allowed_actions": "all"}`.
- The **Actions tab carried no banner** — no "I understand my workflows, go
  ahead and enable them", no billing warning. Confirmed in a real browser, not
  inferred. The CI workflow's own page said simply "This workflow has no runs
  yet", with no invalid-file error.
- Settings → Actions → General had **"Allow all actions and reusable
  workflows"** selected; repo `archived: false`, `disabled: false`, public.
- `ci.yml` has been on `main` since **6 May 2026**, inherited from upstream.
- The events definitely arrived: `/events` records `PushEvent refs/heads/main`
  for #5's merge and `PullRequestEvent`s for #6 and #7.

So the fork-gate theory was checked and **disproven** on every observable, yet
the remedy was still to toggle Actions. Do not spend time re-deriving the cause
from `isFork: true` — the diagnosis is not available through the API. **The
diagnostic that works is the run count per workflow**, which is the one number
none of the healthy-looking surfaces shows:

    gh api repos/<owner>/<repo>/actions/workflows/<id>/runs --jq .total_count

### Merging now deploys — and that path is broken

Enabling CI turned on a chain that had never been exercised, and the first run
proved out exactly how it behaves:

- `build.yml` runs on push **and** pull request to `main`.
- `deploy.yml` triggers on `workflow_run: workflows: ["Build"], types:
  [completed]` with **no branch filter** — its only guard is
  `conclusion == 'success'`.
- `prepare` reads the build's ref: `refs/heads/main` sets `is_production=true`,
  anything else `false`, and `deploy` picks its environment from that. A PR
  build targets `preview`; **a merge to `main` targets `production`.**

There are **no environments and no protection rules**, so nothing asks for
approval.

**It fails rather than deploys, and that is measured, not assumed.** The Deploy
run triggered by #6's Build reached `bun cli/bin/rin.ts deploy --preview` and
died on the first Cloudflare API call:

    Failed to create D1 "rin-preview"
    ✘ [ERROR] In a non-interactive environment, it's necessary to set a
      CLOUDFLARE_API_TOKEN environment variable

The repository has **zero Actions secrets**, and `deploy.yml` needs
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `JWT_SECRET`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD` and the `S3_*` pair. Nothing was uploaded and no Worker was
published — it never authenticated.

Two consequences:

- **This deploy path has never been functional**, so it is *not* what deploys
  blog.pearcache.com. Whatever does (Cloudflare's own Git integration, or a
  hand-run `wrangler deploy`) is not visible in this repository — the same trap
  the ears repo records under its two-deploy-paths note.
- **Every merge to `main` now produces a red `Deploy`** until either the secrets
  are added or that workflow is disabled. `ci.yml` and `test.yml` reference no
  secrets and run clean, so the gates themselves are trustworthy; the red X is
  the deploy chain alone. Decide which you want before reading a failed Deploy
  as a broken build.

### The gates still are not what they appear

`bun run format:check` remains a `ci.yml` gate that cannot fail — the script is
declared in `turbo.json` and root `package.json`, but no workspace defines it,
so it resolves `Tasks: 0 successful, 0 total` and exits 0 unconditionally. It
now *runs*, and still checks nothing.

### The `Deploy` workflow is disabled, and that fact lives outside this repo

Disabled 16 Sep 2026, immediately after the section above established that it
can only ever fail. **Nothing in `.github/workflows/deploy.yml` records this** —
the file is untouched and still reads as a live workflow. The state is held by
GitHub:

    gh api repos/<owner>/<repo>/actions/workflows --jq \
      '.workflows[] | "\(.state)\t\(.name)\t\(.path)"'
    # deploy.yml -> disabled_manually

This is the same shape as the ears repo's note that Workers Builds was
disconnected in the Cloudflare dashboard: a deliberate decision that no file in
the repository can show you. If `deploy.yml` ever appears not to run and the
workflow looks fine, **check the state before debugging the YAML.**

**Why it is off.** It triggers on any successful `Build` with no branch filter,
so every merge to `main` produced a red `Deploy`. It cannot succeed: the
repository has zero Actions secrets and the workflow needs six. It is also not
the path that deploys blog.pearcache.com, so nothing is lost by it being off.

**Re-enabling** — needed if the Cloudflare secrets are ever added:

    gh api -X PUT repos/<owner>/<repo>/actions/workflows/352871635/enable

or Actions → Deploy → ⋯ → Enable workflow. Add the six secrets first, or it
will simply go red again.

**Disabling covers `workflow_dispatch` too**, so the manual "deploy this
artifact" button is gone as well. That button never worked either, for the same
missing-secrets reason.

**Careful with the name.** There are two workflows whose names begin with
"Deploy": `Deploy` (`deploy.yml`, id 352871635, the Cloudflare one, now
disabled) and `Deploy Rspress site to Pages` (`docs.yml`, id 352871636, GitHub
Pages, still active and unrelated). `gh workflow disable Deploy` matching by
name is ambiguous — disable by **id**.

`Build` is deliberately left active. It is a real check that the app compiles,
it passes, and with `Deploy` disabled it no longer chains into anything.

## turbo 1 → 2 — 16 Sep 2026

Closes the last four Dependabot alerts (GHSA-hcf7-66rw-9f5r moderate,
GHSA-3qcw-2rhx-2726 low, each counted twice because turbo was declared in two
directories). Neither was reachable — the section above says why — so this is
hygiene, and the interesting part is what the upgrade *found*.

**The patched version is 2.9.14, not "2.x".** Both advisories cover
`<= 2.9.13` / `< 2.9.14`, so a bump that stopped at 2.0 would have closed
neither. Taken to 2.10.13.

### Only the root bumped; `client`'s turbo was deleted

`client/package.json` declared `turbo` and **never invoked it** — no turbo in
any of its nine scripts, and no `client/turbo.json`. Turbo is the monorepo
orchestrator and only the root's `check`, `build:all` and `format:*` scripts
call it. So two of the four alerts are closed by removal rather than upgrade,
the same reasoning as `@cloudflare/vite-plugin` above: a version bump on a
package that never loads buys nothing.

### The one breaking change, and it fails loudly

`turbo.json`'s `pipeline` key is `tasks` in 2.x. turbo says so precisely, with
the offending span and the fix, and **exits 1** — it does not silently run
nothing:

    x Found `pipeline` field instead of `tasks`.
    help: Changed in 2.0: `pipeline` has been renamed to `tasks`.

One key renamed. No codemod needed, and nothing else in this config was
rejected.

### REAL DEFECT, pre-existing, found by turbo 2's warning — `build:all` could
report success having built nothing

turbo 2 warns where turbo 1 was silent:

    WARNING  no output files found for task client#build.
             Please check your `outputs` key in `turbo.json`

`turbo.json`'s `build` task declares `outputs: ["dist/**"]`, and turbo resolves
outputs **relative to each package**. `rin-server` writes to `server/dist`, so
that is correct for it. The client's vite config writes to `../dist/client` —
the repository root's `dist/`, **outside the client package** — so turbo
captured nothing for `client#build` and a cache hit restored nothing.

Reproduced, not theorised:

    rm -rf dist/client && bun run build:all
    -> client:build: cache hit, replaying logs
    -> Tasks: 2 successful, 2 total     exit 0
    -> dist/client/index.html: MISSING

A green build that produced no artifact — the fail-silent class this file keeps
returning to.

**Fixed** with a per-package override, because turbo `outputs` cannot point
outside the package and moving the client's `outDir` would mean changing
`wrangler.toml`'s `[assets] directory` too:

    "client#build": { "dependsOn": ["^build"], "cache": false }

`rin-server#build` keeps its working cache. Verified the same way it was found:
`rm -rf dist/client && bun run build:all` now reports `cache bypass, force
executing`, runs `tsc && vite build`, and the artifact is there.

**Blast radius was small and is worth knowing:** nothing calls `build:all`.
CI's `build.yml` and the deploy path use `bun run build`
(`build:client && build:server`), which never goes through turbo. So this only
ever bit someone running `build:all` by hand — but it bit them silently.

### Two things the upgrade improved for free

- **turbo 1.13 could not parse `bun.lock`.** Every run printed
  `could not resolve workspaces: unable to parse ... "client@^workspace:client"`
  — it was reading a bun lockfile with its yarn parser. Gone in 2.x: zero
  occurrences in any run since.
- **`format:check` now says it did nothing.** turbo 2 prints
  `WARNING No tasks were executed as part of this run.` where turbo 1 printed
  only `Tasks: 0 successful, 0 total`. It still **exits 0**, so it is still a
  `ci.yml` gate that cannot fail — see above — but the upgrade at least makes
  the emptiness visible in the log. Fixing it properly still means giving a
  workspace a real `format:check` script or dropping the gate.

### Verified

| gate | result |
|---|---|
| `bun run check --force` | exit 0, 0 TS errors |
| `bun run test:server` | 319 pass / 0 fail |
| `bun run test:client` | 38 pass / 0 fail |
| `bun run build:server` | exit 0 |
| `bun run build:all` | exit 0, artifact present |

## `bun.lock` resolves half its packages from a mirror — 16 Sep 2026

Noticed while diagnosing a CI failure, checked, and **left alone deliberately**.
Recorded so it is a known property rather than a surprise.

`bun.lock` records a resolved tarball URL per package, and this one is **split**:

| source | entries |
|---|---|
| `https://registry.npmmirror.com` | **803** |
| empty, i.e. the default registry (`registry.npmjs.org`) | **740** |
| anything else | 0 |
| total | 1,543 |

It is **not** a configuration. There is no `.npmrc` and no `bunfig.toml`
anywhere in this repository, so nothing here selects a registry. The URLs are
baked into the lockfile, inherited from upstream — `bun.lock` arrives in
openRin's `b0de3bb chore: migrate Bun lockfile format (#506)` — and they persist
for any package whose entry is not re-resolved.

That is also why the split exists and why it moves: every package installed or
updated since carries the empty (default) field, including everything touched by
#6, #7 and #8. **The mirror's share decays on its own** as dependencies are
bumped.

### Why this is lower risk than it sounds, and where the risk actually is

- **Integrity is pinned.** All 803 mirror-sourced entries carry a `sha512`
  hash — checked, none missing — so a tampered tarball fails verification rather
  than installing. This is not "arbitrary code from a mirror".
- **The real exposure is first resolution.** A hash pins what you already have;
  it does not tell you the first fetch was honest. Every one of those 803 hashes
  was recorded by whoever originally resolved it, upstream, through the mirror.
- **It is a third-party availability dependency.** An install pulls those
  tarballs from a host neither this project nor npm controls.

### Do not blame this for the mermaid flake

CI went red once on `5716834` with `error: Fail extracting tarball for
"mermaid"` during `bun install`, and the obvious move is to pin it on the
mirror. **`mermaid@10.9.5` resolves from the default registry, not npmmirror** —
checked. A re-run passed. So that was an ordinary transient download failure,
and it is evidence of nothing about the mirror.

**It recurred on 23 Sep 2026:** `format-check` in "CI - Test and Type Check"
on `8a0b422` (run `35916370546`), with the same `Fail extracting tarball for
"mermaid"` during install. It was the only failing job; test, typecheck and
coverage passed. The same workflow was green on all 8 earlier `main` runs
in the last-10 listing, and again on `fd5eb87`. Still transient, and still nothing to fix. If it
starts recurring often, it is worth a cache or retry on `bun install` in CI.

### Why it was not "fixed"

Forcing re-resolution (an `.npmrc` plus a lockfile regeneration) would rewrite
most of a 1,543-entry lockfile in one commit. That trades a documented,
hash-pinned property for a diff **nobody can meaningfully review**, which is a
worse position for a repository that treats review as the control. The decay
above gets there without a flag day.

If it is ever worth forcing, do it as its own PR with nothing else in it, and
say in the description that the diff is machine-generated and what was checked
instead of reading it.

## What actually deploys blog.pearcache.com — answered 16 Sep 2026

The note above said the real deploy path "is not visible in this repository".
It still is not, but it is now known: **a hand-run `wrangler deploy` from the
owner's machine.** Nothing automated deploys this site.

Read from the Cloudflare API, which is run evidence rather than config:

- `blog.pearcache.com` is a **custom domain** bound to the service
  `rin-server`, production — so this repo's worker is the thing serving it.
- **All 10 deployments and all 20 versions** of `rin-server` carry
  `source: "wrangler"` and `author_email` set to the owner's account email. There is no
  other source in the history.
- The worker's `modified_on` is **2026-09-10T06:46:48Z**, identical to the
  newest deployment, and there are **zero deployments after it**.

### The two automated paths were ruled out, not assumed away

- **GitHub Actions is not it.** `deploy.yml` has never run (see the CI section
  above), and the repository has zero Actions secrets against the six it needs.
  It is now disabled outright.
- **Cloudflare Workers Builds is not it either.** The Workers Builds API returns
  `total_count: 0` for this worker — it has never built once.

  The misleading part: a **`cloudflare-workers-and-pages` check suite is created
  on every push to `main`**, going back at least to 10 Sep, and every one sits
  at `queued` forever. That is the Cloudflare GitHub App being installed on the
  account, not a build running. **Do not read those queued suites as a pending
  deploy.** They will never complete, because nothing is connected.

### PRODUCTION IS STALE, and this is the part that matters

The last deploy, `2026-09-10T06:46:48Z`, lands **28 seconds** after commit
`f473b8d chore: rename articles heading to posts`
(`2026-09-09T23:46:20-07:00` = `06:46:20Z`) — the owner committed, then ran
`wrangler deploy`. Nothing has been deployed since.

So everything merged after that commit **is not live**:

| merged | not live |
|---|---|
| #3 `755b51b` | fast-xml-parser 5.11.1 |
| #5 `343837c` | **the entire security audit fix set** |
| #6 `11f04d7` | drizzle-orm 0.45.2 |
| #7 `5716834` | i18next allowlist + bump, dead plugin removed |
| #8 `6f8e8fb` | turbo 2, build-cache fix |

**#5 is the one to care about.** Every item this file records as "REAL, FIXED"
is fixed *in the repository* and still live *on the site*: guest comments
accepting unbounded anonymous writes, the `javascript:` URI injection through
`guestWebsite`, guest email addresses published to every reader, no security
headers at all, and `parseBody()` running before the auth check on upload.
"Fixed" in this file has meant "fixed in main". It has never meant "deployed".

### The weakness of the manual path, stated plainly

`wrangler deploy` ships the **working tree**, not a commit. Cloudflare records
who deployed and when, but **nothing anywhere records which commit is live** —
the 28-second correlation above is an inference from timestamps, not a stored
fact, and it would not survive a deploy made from a dirty tree.

Two consequences worth keeping:

- To know what is live you must correlate `modified_on` against `git log` by
  hand, and accept that the answer is approximate.
- There is no reason for this repo's CI to be trusted as a deploy gate, because
  it does not gate the deploy. A green `main` says the code is good; it says
  nothing about the site.

If this is ever automated, the honest fix is the one `deploy.yml` already
gestures at — add the six secrets, re-enable that workflow (see the note above
on how it is disabled), and let a merge be the deploy. Until then, **a merge is
not a release**, and this file should not imply otherwise.

## Verified live from a HAR — 18 September 2026

First behavioural measurement of this site in production. Everything before this
was read from config, from `main`, or from a Worker `modified_on` timestamp. It
confirms the security fixes are deployed, and it finds that **one of them does
not apply where it matters most.**

HAR captured from a real browser, 28 entries, `2026-09-18T19:19:09Z`. A session
cannot do this itself — the egress proxy refuses this zone — so this is the only
kind of live evidence available here.

### The security headers are live, and they do not reach the document

`SECURITY_HEADERS` from PR #5 is **deployed and working**: all five headers are
present on every response the Worker returns. So #5 is live, which also settles
the older question — the 17 Sep deploy did carry the security audit fix set.

They are absent from the front page. Not intermittently: structurally.

    asset? hdrs?  st   path
    YES    no     200  /
    YES    no     200  /assets/index-qnGRV1dD.js
    YES    no     200  /assets/index-BUSSL3yr.css
    YES    no     200  /locales/en/translation.json
    YES    no     200  /assets/remixicon-BCkO1-UF.woff2
    no     YES    200  /api/config/client/bootstrap.js
    no     YES    200  /api/feed
    no     YES    200  /api/user/profile
    no     YES    200  /api/feed/2
    no     YES    200  /api/feed/adjacent/2
    no     YES    200  /api/comment/2
    no     YES    403  /favicon.ico  (x2)

`asset?` is membership of `dist/client`, tested mechanically against the built
manifest rather than by eye. **5 of 5 asset-store paths carry none of the four
headers; 8 of 8 Worker paths carry all of them.** Zero exceptions. The other 8
entries in the HAR are Cloudflare's own (`/cdn-cgi/rum`, the challenge platform,
speculation rules) plus the refused prefetch below, none of which reach a Worker
by definition.

**Cause: asset-store-first routing.** `[assets]` in `wrangler.toml` has no
`run_worker_first`, so a request whose path matches a file in `dist/client` is
answered by Cloudflare's asset store and **the Worker never runs**. Corroborated
by the responses themselves: every header-less response carries
`cf-cache-status: HIT` and `server-timing: cfOrigin;dur=0` — the origin was not
contacted — while every Worker response carries no `cf-cache-status` at all.

**This is not a stale cache and a purge will not fix it.** That was the first
reading — `cache-control: public, max-age=0, must-revalidate` with
`cf-cache-status: HIT` looks exactly like an edge copy predating the deploy — and
it is wrong. The comment in `fetch-handler.ts` asserting that "every response
here — API, static asset and SPA entry — is returned from handleFetch" was wrong
in the same direction, for the same reason: the Worker's own
`tryServeAsset`/`serveSpaEntry` calls only run for requests that got to the
Worker. That comment is now corrected in place.

**Consequence: `/` has no CSP**, which is the one document where CSP does
anything. `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` are
missing there too, and `frame-ancestors 'none'` is missing with them, so the
front page is framable today.

**Fix, one line, not applied:**

    [assets]
    directory = "./dist/client"
    binding = "ASSETS"
    run_worker_first = true

The boolean, **not** a path allowlist — `run_worker_first` scoped to document
paths silently served `index.html` in place of every `/api/` response in
ears-pearcache, which is the sibling repo where this whole mechanism was first
learned. This handler is already written for it: `route()` calls `tryServeAsset`
and `serveSpaEntry` itself, so the Worker can serve every asset. Left unapplied
because it invokes the Worker on every asset request — a CPU-billing and latency
change that is the owner's call, and it needs a deploy, which was out of scope.

### The 503 is a refused prefetch, and the response header says so

    GET /feed/2 -> 503, empty body, 24ms
      cf-speculation-refused: prefetch refused: disabled for worker requests
      vary: sec-purpose

It is the **only** request in the HAR carrying `sec-purpose: prefetch`, and the
zone injects `speculation-rules: "/cdn-cgi/speculation"` on every response. So
Cloudflare Speed Brain speculatively prefetched the next page, refused its own
prefetch because the path is Worker-backed, and returned an empty 503 that no
user ever sees — the real navigation fetched `/api/feed/2` and got 200.

**Not a fault, and nothing to fix.** This also independently confirms the same
conclusion reached for ears-pearcache's intermittent `/bandcamp` and `/directory`
503s (empty body, `server: cloudflare`, no `cf-cache-status`, 24–98ms, fine on
retry — an exact shape match). That repo's note records those as unobservable
after 24 hours because the analytics window is one day. This capture happens to
carry the cause **in a response header**, which is the evidence that was missing.
If a 503 like this turns up again, read `cf-speculation-refused` before opening
analytics.

### The favicon is 403 — our own R2 host denies the Worker

    GET /favicon.ico -> 403, text/plain, body = a Cloudflare error page
    "This resource is blocked by this account's Default-Deny policy"  (code 1050)
    "... | images.pearcache.com | Cloudflare"

`/favicon.ico` is not a file in `dist/client` (`favicon.png` is), so it reaches
the Worker, `FaviconService` misses the stored `images/favicon.webp`, falls back
to building one from `site.avatar`, and fetches that avatar from
`S3_ACCESS_HOST` = `https://images.pearcache.com` — which answers the Worker's
server-side fetch with a Cloudflare Access **Default-Deny**. The 403 and the
block page are then passed straight through as `c.text(...)`, which is why a
`text/plain` response contains an HTML document.

The site has had no favicon for as long as that policy has been in place. Fixing
it is an Access policy change on `images.pearcache.com`, not a code change —
note the estate review recorded that hostname as public with a
`bypass (everyone)` policy, so either that changed or the bypass does not cover
this path. Verify before editing anything.

**Checked 23 Sep 2026: the bypass exists, and it is only this Worker it fails
for.** The `images` Access app (hostname destination, `bypass` / everyone) was
created 10 Sep 06:20Z, before the 18 Sep HAR. Zone analytics for 15–22 Sep,
split by `requestSource`, show:
- every 403 on `images.pearcache.com/images/*` is `edgeWorkerFetch`, almost
  all for `images/126b0bd8….png`, this avatar
- browser (`eyeball`) requests for `/images/*` get 200/304 through the same
  app

So the bypass works for people and not for `rin-server`'s own subrequest. Why
is not established. The one-line Access fix this note anticipated would
therefore not be enough. A code-side option that avoids the question entirely
is to read the avatar through the S3 API the Worker already holds credentials
for, instead of an HTTP fetch of `S3_ACCESS_HOST`. Note that the deployed
`rin-server` has **no `r2_bucket` binding** (its bindings list shows only the
`S3_*` variables and secrets), so any code path that expects `R2_BUCKET`
should be checked against that. Not changed.

### FIXED 23 Sep 2026 — by seeding the stored favicon, not by touching Access

`GET /favicon` (`server/src/services/favicon.ts`) first reads
`images/favicon.webp` with `getStorageObject()`, which uses the S3 API and
this Worker's credentials, not an HTTP fetch of `S3_ACCESS_HOST`. It only
falls back to building a favicon from the avatar when that object is missing.
The object had never existed, and **both ways of creating it are broken
here**:

- **The avatar fallback** (`buildFaviconFromSource`) fetches
  `https://images.pearcache.com/images/<avatar>` and gets the
  Worker-subrequest 403 described above.
- **The admin upload** (`POST /favicon`) stores the original, then transforms
  it with the same kind of fetch against `getStoragePublicUrl()`, which is
  also `S3_ACCESS_HOST`. It fails the same way.
- **Both pass `cf: { image: … }` (Image Transformations), and transformations
  are OFF on the `pearcache.com` zone** (`image_resizing: off`, read from the
  zone settings API on 23 Sep). So even without the 403, neither path could
  produce the 144px webp it expects. What `cf.image` does on a zone with
  transformations off was not established.

The fix was to write the object directly:

- **Source:** the avatar `images/126b0bd819e8e68bf989e96ffaeb611b55edc694.png`
  (288×288 RGBA). Its SHA-1 equals its key, which confirms uploads are
  content-addressed.
- **Conversion:** this repo's own `sharp`, with the parameters the code asks
  Cloudflare for: `resize(144, 144, { fit: "cover" })` →
  `webp({ quality: 100 })`. Result: 11,680 bytes, 144×144, alpha kept. It was
  inspected visually before upload.
- **Upload:** `wrangler r2 object put pearcache-images/images/favicon.webp
  --content-type image/webp --remote`, at 24 Sep 01:12:14Z (23 Sep in PDT).
- **Checked first:** `images/favicon.webp` and every `originFavicon.*` key
  were absent, so nothing was overwritten.
- **Verified:** read back from R2, the SHA-256 matches the local file
  (`759f2172…`).

**Not verified live:** the rendered favicon on `blog.pearcache.com`, because
a session cannot request pearcache.com hosts. To check, load the blog in a
real browser. The favicon may need a hard refresh, since the old failures
were never a cached success. Once it is served, the
`edgeWorkerFetch` 403s on `images/126b0bd8….png` in zone analytics should
stop, because that fetch only happens when the stored object is missing.

**If the avatar changes, regenerate this file by hand the same way.** The
built-in paths will keep failing until the Worker-subrequest 403 is solved or
transformations are enabled. A new admin upload stores `originFavicon.<ext>`, then
fails with the 403 text before it writes `favicon.webp`, so it does not
overwrite this file.

### Workers Logs is OFF in production, by this repo's own generator

`wrangler.toml` is gitignored and **generated** by
`cli/src/tasks/deploy-cf.ts`. `buildWranglerObservabilityConfig(preview)`
returns `""` unless `preview` is true, so production `rin-server` deploys with
no `[observability]` block. That is why Workers Logs returns nothing for it:
zero events over 22–23 Sep, while the account's `workersInvocationsScheduled`
analytics show the `*/20` cron succeeding. **An empty logs query here is not
evidence that nothing ran.** Use the scheduled or invocation analytics
instead.

To turn logs on, change the generator, **not** `wrangler.toml`: the local file
was rewritten at the time of the last production deploy (18 Sep 13:12 PDT),
so a hand edit would be lost on the next one. Make
`buildWranglerObservabilityConfig` emit the logs block for production too, and
update `cli/src/tasks/deploy-cf.test.ts`. It takes effect at the next
hand-run deploy. Not changed.

### What this HAR does NOT show

`GET /api/comment/2` returned `[]` — post 2 has no comments. **An empty array
cannot demonstrate that a field is absent**, so the other half of #5, dropping
`guestEmail` from the comment response, is **untested in production**. It passes
its unit tests and it is in the deployed bundle; it has not been observed. To
close it, capture a HAR on a post that actually has a guest comment.

Also confirmed healthy, for the record: `nosniff` and HSTS
(`max-age=15552000; includeSubDomains`) on everything, `/cdn-cgi/rum` returning
**204** three times (the load-bearing observation for Web Analytics, not the
beacon's own 200), and zero CSP-blocked requests.

## The deploy now records which commit it shipped

`wrangler deploy` ships the working tree, not a commit, so nothing anywhere
recorded what was serving — "is the fix live?" was answered by correlating the
Worker's `modified_on` against `git log` by hand, which is an inference, and a
wrong one for any deploy carrying uncommitted files.

`runCloudflareDeploy` now passes `--message <short-sha>` to both of its
`wrangler deploy` calls. The annotation comes back from the deployments API and
from `wrangler deployments list`, so the answer is read from the same place as
the timestamp:

```bash
bunx wrangler deployments list
```

`formatDeployMessage` has one requirement — **it must not claim more than it
knows.** A dirty tree is labelled `<sha>-dirty`, never that bare sha; absent git
is `no-git`, not an empty message that would read identically to a deploy made
before this existed. It is **not** a gate and does not refuse a dirty deploy;
hotfixing from a working tree is how this site is actually operated, and a guard
that blocked it would just be bypassed.

Verified: `--message` is accepted by wrangler **4.71.0**, the version pinned in
`package.json`, against this actual config via `wrangler deploy --dry-run`. That
check is not ceremony — in a sibling repo a `wrangler kv` invocation that worked
locally failed on a runner because a flag did not exist in the version that ran
there, with an error that read like a malformed command.

**The first deploy after this merges is the first one whose commit is recorded.**
Everything before it stays an inference, including the 17 Sep deploy that this
HAR shows carried the security headers.

### The marker named the wrong version on its very first use

Deployed 18 Sep 2026 at 20:05:04Z with `Message: 7886b9e` — and seven seconds
later `wrangler deployments status` reported the active version as a *different*
one, `cff2e38f`, carrying `Message: -`.

**Cause: `wrangler secret bulk` creates a Worker version of its own**, because
secrets are bindings. `syncWorkerSecrets` ran after `wrangler deploy`, so it
stacked an unannotated version on top of the annotated one. The marker was
therefore describing a version that had already been superseded — and doing it
with complete confidence, which is worse than not having it. `wrangler deploy`
being the last *command* is not the same as its version being the last one.

**Fixed by ordering, not by adding anything:** secrets are synced **before** the
deploy, so the annotated deploy is the last version created. Secrets persist
across deploys, so this costs nothing — the final version carries both. The only
exception is the first deploy of a brand-new Worker, where the pre-deploy sync has
nothing to attach to; it then runs again afterwards, which leaves one unannotated
version on a Worker nobody is yet asking questions about.

Two notes for anyone touching that function:

- **`syncWorkerSecrets` no longer throws**, it returns whether it ran, because the
  caller now has to decide what to do about a sync that could not happen yet.
- **The `if (target === "server")` branch was deleted, not rewritten.** Its body
  was byte-identical to the fallthrough beneath it — `deploy` then sync, twice.
  `target` is already handled earlier, where it decides whether the client is
  built.

**Verify this after any change to the tail of `runCloudflareDeploy`:**

```bash
bunx wrangler deployments status
```

The **active** version's `Message` must be the sha. Reading `deployments list` is
not enough — the annotated version was present in that listing the whole time
while a later one served.

### Measured: `run_worker_first = ["/"]` closes it, and the allowlist trap does not apply here

Run against `wrangler dev` on 18 Sep 2026, three configs, same probe set. `CSP`
and `XFO` are header presence; `json` means the response was `application/json`
rather than `index.html`.

| path | current | `["/"]` | `true` |
|---|---|---|---|
| `/` | **no headers** | headers | headers |
| `/assets/index-*.js` | no headers | no headers | headers |
| `/api/feed` | json + headers | **json** + headers | json + headers |
| `/api/user/profile` | json + headers | **json** + headers | json + headers |
| `/feed/2` | headers | headers | headers |
| `/favicon.ico` | headers | headers | headers |

**The control is the load-bearing row.** With the current config `wrangler dev`
serves `/` as 200 HTML with no CSP and no `X-Frame-Options` — reproducing the
production HAR exactly. The rig could therefore fail, and did, in the same way
production does; without that row neither variant's result would mean anything.

**The ears misroute trap does not fire here, and now we know why.** Scoping
`run_worker_first` to document paths in ears-pearcache served `index.html` in
place of every `/api/` response. Under `["/"]` here, `/api/feed` and
`/api/user/profile` both still returned `application/json`. The difference is
`not_found_handling`: ears sets it, so an unmatched path is answered by the asset
store; this config sets none, so an unmatched path falls through to the Worker.
**Do not carry that warning across as though it applied — but do re-check it if
`not_found_handling` is ever added here.**

`["/"]` is sufficient because `/` is the only document the asset store can
answer: `index.html` is the single HTML file in `dist/client`, `/index.html`
answers **307 → `/`** (verified, so it is not a bypass), and `/about`,
`/timeline`, `/feed/2` match no file and already reach the Worker. `true`
additionally wraps the JS, CSS, fonts and locale JSON, where these headers do
nothing — CSP and `X-Frame-Options` are enforced per document, not per
subresource.

Cost, from the front-page HAR: 4 Worker requests per view today; `["/"]` makes it
5, `true` makes it 9. At this traffic both sit inside the 10M/month included on
Workers Paid, so the invoice is not the argument. The argument against `true` is
`[placement] mode = "smart"`, which relocates execution near D1 and would route
static assets through that colo instead of the local edge — **and that cost
cannot be measured locally**, which is itself a reason to prefer the variant that
does not incur it.

Two test-rig notes so this is reproducible: `[ai]` must be removed from the
config for `wrangler dev` to boot (no local emulation, so it forces a remote
proxy session that fails to authenticate), and it has no bearing on routing. The
`500`s on `/api/feed` and `/favicon.ico` are local-only — unmigrated local D1 and
no R2 — and identical across all three variants, which is what shows they are not
caused by the routing change.

**Applied as `["/"]`**, in `buildWranglerAssetsConfig()` in
`cli/src/tasks/deploy-cf.ts` — the **generator**, because `wrangler.toml` is
rewritten on every deploy and an edit to the checked-in file would be silently
discarded. It takes effect on the next deploy; nothing was deployed here.

Verified against the **exact file the generator now produces** (the builder's
output spliced into the real config, so the column-0 `[assets]` header that
interpolation yields was tested, not just the hand-indented form):

    /                             200  CSP+XFO   text/html      <- the fix
    /about, /feed/2               200  CSP+XFO   text/html
    /api/feed                     500  CSP+XFO   application/json
    /api/user/profile             403  CSP+XFO   application/json
    /assets/index-*.js            200  none      text/javascript  <- intended
    /locales/en/translation.json  200  none      application/json <- intended
    /index.html                   307  none      -> /

`buildWranglerAssetsConfig` is exported and tested for the same reason its three
siblings in that file are: the failure mode of losing that line is a front page
that renders perfectly with no CSP and no `X-Frame-Options`, and nothing else in
this repo would notice. One test asserts the line is present; another asserts it
is **not** `true`, so widening it is a deliberate edit rather than a silent
latency regression through the smart-placement colo.

## The front page's CSP, confirmed live — 18 September 2026

`run_worker_first = ["/"]` was deployed at **20:12:43Z** (version
`53499392`, `Message: d394409`) and confirmed by a browser HAR captured at
**20:17:01Z**, 4m18s later. `/` carries all four headers and the CSP
byte-matches the `CSP` constant in `fetch-handler.ts`:

    content-security-policy: default-src 'self'; script-src 'self'; ... frame-ancestors 'none'; ...
    x-frame-options:         DENY
    referrer-policy:         strict-origin-when-cross-origin
    permissions-policy:      geolocation=(), microphone=(), camera=(), payment=()

So the front page is no longer framable, and this is the first end-to-end
confirmation in this repo's history: measured locally, deployed, then observed
live. The static assets still carry none of them, which is the design working —
they stay on the asset-store fast path, where a CSP header on a `.woff2` does
nothing.

### `cf-cache-status: HIT` no longer means the Worker was bypassed

This fix inverted the signal used to find the bug, so the next person to read it
the old way will reach the opposite wrong conclusion.

`/` **still** answers `cf-cache-status: HIT`. It is now passed through from the
Worker's own internal `env.ASSETS.fetch()`, because `withSecurityHeaders` copies
every header off that response. What actually changed is `server-timing`:

| | before the fix | after |
|---|---|---|
| `cf-cache-status` | `HIT` | `HIT` (unchanged!) |
| `server-timing` | `cfCacheStatus;desc="HIT"`, `cfEdge;dur=10,cfOrigin;dur=0`, `cfExtPri` | `cfExtPri` only |

**`cfOrigin;dur=0` is the discriminator**, not `cf-cache-status`. Reading `HIT` as
"served from the edge without the Worker" is exactly what made this look like a
stale cache for the first half of the investigation, and it is now wrong in the
other direction too.

### Unchanged by this, and still open

- **`/feed/2` 503** — identical cause, `cf-speculation-refused: prefetch refused:
  disabled for worker requests` with `sec-purpose: prefetch` on the request. Not
  a fault; not affected by the routing change.
- **`/favicon.ico` 403** — still the Cloudflare Access **Default-Deny** page from
  `images.pearcache.com`. An Access policy change, not a code change.
  *(Fixed 23 Sep 2026 by seeding the stored favicon; see "FIXED 23 Sep 2026"
  above.)*
- **`guestEmail` is still unobserved.** `/api/comment/2` returned `[]` in this
  capture too, because post 2 has no comments, and an empty array cannot show
  that a field is absent. Needs a HAR on a post with a guest comment. Do not
  record this as verified until then.

## README corrections — 18 September 2026

Three things the README asserted were wrong, all checked rather than assumed:

- **`bun run deploy:server` / `deploy:client` do not exist.** `package.json` has
  only `deploy`; the target is a flag (`--server` / `--client`).
- **`bun run deploy` does not deploy the frontend to Pages.** `wrangler pages
  deploy` is reachable only when `target === "client"`; the default path serves
  the built client through the Worker's `[assets]` binding. Believing the Pages
  claim is a good way never to look at `[assets]`, which is where the missing-CSP
  bug lived.
- **`deploy.yml` is `disabled_manually` and this fork holds none of the Actions
  secrets**, so "`build.yml` … triggers deployment" is false here. The README now
  says so, because the previous text actively pointed away from the fact that
  every release is a hand-run `bun run deploy`.

`README_zh_CN.md` is upstream's translation and was **not** updated — it now
disagrees with `README.md` on these three points. Left alone deliberately rather
than machine-translating fork-specific operational notes; the authoritative
statement of all of this is here in CLAUDE.md.

## Pre-public fixes, and a deploy that shipped the wrong build — 23 September 2026

A security pass before taking the blog out from behind Access found four
things worth fixing first. **The blog went public on 24 Sep 2026 (UTC)**,
after these were confirmed in the live script: a hostname-level Access
`bypass` app, like the ears site's. The Worker's `workers.dev` and preview
URLs still require a login. From here on the login endpoint is reachable by
anyone, so the throttle below is a live defence, not a precaution. They are #19 (`2fe14b1`); the PR description has
the mechanism and the tests for each:

1. `/blob/*` scoped to `S3_FOLDER`, and storage keys percent-encoded wherever
   an S3 URL is built (the ListObjectsV2 hole above).
2. Login tokens expire after 7 days, and a token without `exp` is refused.
   Every token issued before the deploy stopped working, whatever the secret.
3. Failed logins throttled: five per IP per 15 minutes, keyed on
   `cf-connecting-ip` only. Table `login_attempts`, migration `0013.sql`.
4. Anonymous search leaves out drafts and unlisted posts.

`JWT_SECRET` was rotated in `.env.local` before the deploy, so the deploy's
secret sync set the new value. **Being logged out proves nothing about the
rotation** (see 2); only the value in `.env.local` does.

### The first deploy of #19 shipped the 16 Sep bundle

`bun run deploy` printed `Current Version ID: bb68a388…`, and the deployment
was annotated `2fe14b1`, the right commit. The migration ran
(`migration_version` = 13, `login_attempts` present). **None of the code was
live.** Searching the active script for `Too many failed login attempts` and
`login_attempts` found neither.

Cause: `runCloudflareDeploy` used `dist/server/_worker.js` whenever that file
existed, and only bundled `server/src/_worker.ts` when it did not. The local
`dist/server/_worker.js` was from 16 Sep 21:09 PDT and had never been rebuilt.
`buildClient` has the same shape for `dist/client`. Nothing in the output said
which bundle was used. The `--message` annotation comes from the checkout's
HEAD, not from the bundle, so it named a commit the bundle did not contain.

Recovered by deleting `dist/server` and deploying again: version `425d9758`,
deployment `a36f4238` (24 Sep 04:05Z), with all four fixes found in the
active script.

**The 18 Sep deploys (`7886b9e`, `d394409`) almost certainly shipped the same
16 Sep bundle.** It predates both, and nothing rebuilt it until 23 Sep. They
lost nothing that runs: the only `server/src` change after the bundle's source
commit (`ddf2be3`) was comments in `fetch-handler.ts`. Their `run_worker_first`
change did take effect, because it lives in the generated `wrangler.toml`, not
in the bundle.

**Fixed:** `dist/` is reused only when `GITHUB_ACTIONS=true`. That is
`deploy.yml`'s case, which restores the artifacts `build.yml` made for the
commit it deploys. Everywhere else the deploy bundles the server from source
and rebuilds the client, and it prints `📦 Server entry: …` so the output shows
which one ran. A local deploy is slower by one client build (about 30 s here). That is the
price of the annotation being true.

### Verifying a deploy: read the code, not the label

- **Search the active script for a string only the new code contains.**
  `GET /accounts/:id/workers/scripts/rin-server/content/v2` returns it. The
  version ID and the `--message` annotation both looked right on the
  deploy that shipped nothing.
- **Do it straight after the deploy.** Asked for four different versions
  with `?version=`, that endpoint returned byte-identical content, including
  the new strings for the 18 Sep versions, which cannot have had them. It
  only ever returns the active script. So an old version's code cannot be
  read back this way; check each deploy while it is the active one.
- A green CI run on `main` says nothing here. This site deploys by hand.

## `Failed to create D1 "rin"` was an OAuth renewal race — fixed 24 September 2026

Two deploys (23 Sep 03:56 PDT, 24 Sep 05:37Z) stopped at the first step with
`Authentication error [code: 10000]` on `POST …/d1/database`. Running again a
few minutes later worked both times. Nothing had been changed: the script exits
before migrations, secrets or the upload.

**Cause, reproduced by forcing renewals.** wrangler's OAuth token lasts one
hour (`expiration_time` in `~/.wrangler/config/default.toml`). The first
command after it expires renews it. When that command is a D1 call, D1 often
rejects the brand-new token:

| first call after a forced renewal | result |
|---|---|
| `d1 create rin` | 401 (2 of 2) |
| `d1 execute --remote` (the migration query) | 403, code 7403 "account … not authorized" |
| `d1 list` | 401 twice, 200 twice |
| `queues create` | 409 already exists, i.e. accepted |

The same calls from the next process, about a second later, all succeeded.
`whoami` renews through `/user`, which accepts the new token at once. After
`whoami`, 4 of 4 forced renewals were followed by clean D1 list and query
calls.

**Fix, in `runCloudflareDeploy`:**

- `wrangler whoami` runs first, so a D1 call is never the one that renews
  the token.
- The database is listed first and created only when missing. An existing
  database now needs no write at all.
- **It fails closed.** Before this, a database missing from `d1 list` made
  the script skip the `[[d1_databases]]` binding and deploy a Worker with no
  `DB`. Now it exits.

Verified by running the new sequence, with the real `getMigrationVersion`,
after three forced renewals. All three found `rin` and read
`migration_version` 13. A full `bun run deploy` from this code has not run
yet. The next one is the check.

### A deploy is labelled with whatever branch is checked out

The 24 Sep 05:43Z deploy is annotated `465a807`. That commit is on the
docs-only branch of #21, not on `main`, because the checkout had been left
on that branch. The code it shipped is identical to `main` at `7c4f28d`: the
branch differs only in this file. Once #21 is squash-merged, `465a807` is on
no branch. **Run `git checkout main && git pull` before `bun run deploy`**,
or the label names a commit that is hard to find later.

## The blog's look: tokens, fonts and the theme-colour trap — 24 September 2026

The old "Pearcache CLI" theme was replaced by a quieter one (approved via
`/design-shotgun`): warm graphite, one amber accent, IBM Plex Mono for the
header and meta text, Newsreader serif for the reading column. Everything
lives in the tokens at the end of `client/src/index.css`.

- **No page frame, on purpose.** The old `body::before` was `position: fixed`
  at `z-index: 100`, so pages scrolled under a gold rectangle. The fixed
  256px colour glow in `header.tsx` went with it. Don't reintroduce a fixed
  decorative layer.
- **Fonts are self-hosted in `client/public/fonts`** (latin subsets from
  @fontsource 5.3.0, OFL-1.1, licences alongside). The CSP is
  `font-src 'self' data:`, so a Google Fonts link would be blocked. The old
  theme asked for "Fira Code" and never loaded it: every visitor got Courier
  New.
- **`applyThemeColor` used to force pink.** With no `theme.color` configured,
  it wrote the default `#fc466b` inline on `<html>`, and an inline style beats
  any stylesheet. The old CSS hid this with `!important` colours. Now an
  unset or invalid colour clears the inline properties, and the stylesheet's
  accent applies, which is different per colour mode. Setting a colour in
  Settings still overrides it, with one colour for both modes. Check its
  contrast on the light background if you do. The Settings page still
  *displays* `#fc466b` as the current value when none is set.
- **Contrast is written next to the tokens.** Recheck it if a colour changes.
- **Known limits.** The drop cap styles the first paragraph only, so a post
  that opens with an image has none. The `terminal-nav-*` classes used by the
  classic header layout are now unstyled. Production uses the compact layout.
