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
