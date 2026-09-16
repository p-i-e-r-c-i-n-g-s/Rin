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

### OPEN — `/blob/*` is unscoped

`getStorageObject` passes the key straight to `R2_BUCKET.get()` with no folder
scoping, so it is not limited to `S3_FOLDER` (`images/`). Unauthenticated. Low
risk *today* only because that bucket already backs public
`images.pearcache.com` — but it means **never put anything private in
`pearcache-images`.** Not fixed; scope the prefix if that assumption changes.

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

### OPEN — `/blob/*` is unscoped

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

### REACHABLE, shipped, NOT fixed — i18next-http-backend GHSA-q89c-q3h5-w34g

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

**Left for its own change** because 2.5.2 → 3.0.5 is a major bump on a shipped
client dependency. The cheaper, version-independent fix is to stop passing
untrusted input to the URL at all: there are only four locales on disk (`en`,
`ja`, `zh-CN`, `zh-TW`), so an allowlist — `supportedLngs` plus a `loadPath`
function that rejects anything not in it — closes this whichever version is
installed. Prefer that to the bump alone.

### NOT REACHABLE — @cloudflare/vite-plugin GHSA-4pfg-2mw5-f8jx

Moderate, `< 1.6.0`, "exposes secrets over the built-in dev server". The plugin
is a devDependency of `client` at `^0.1.1` and is **never imported**: across 400
non-`node_modules` files it appears only in `client/package.json`.
`client/vite.config.ts` loads `react()` and `visualizer()` and nothing else, so
the plugin's dev server never runs. Positive control: the same grep finds
`@vitejs/plugin-react-swc` in both `package.json` and `vite.config.ts`.

Zero occurrences in the deployed worker bundle.

**The right fix is deletion, not a 0.1 → 1.6 major upgrade.** It is dead weight
that costs a recurring alert. Not removed here only because it is outside this
change's scope.

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
difference, but it is unverified on the CI version until CI runs.
