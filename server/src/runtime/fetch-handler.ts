import { getApp } from "./app-instance";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;
// 由 Worker 直接处理的元数据路由（sitemap / robots），需在静态资源分支之前路由到 Hono 应用
const APP_META_ROUTE_PATTERN = /^\/(sitemap\.xml|robots\.txt)$/;

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isMetaRoute(pathname: string) {
  return APP_META_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return /\.\w+$/.test(pathname);
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      return asset;
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return indexResponse;
    }
  } catch {}

  return null;
}

// Rin had no security headers at all. This adds them to every response that
// handleFetch returns.
//
// THAT IS NOT EVERY RESPONSE THE SITE SERVES, and the original version of this
// comment claimed it was. `[assets]` in wrangler.toml has no `run_worker_first`,
// so Cloudflare's asset store answers any path matching a file in `dist/client`
// WITHOUT INVOKING THE WORKER -- `tryServeAsset`/`serveSpaEntry` below only run
// for requests that got here, which asset requests do not. Measured from a HAR
// of production on 18 Sep 2026: `/`, `/assets/*.js`, `/assets/*.css`,
// `/locales/*/translation.json` and the fonts carried NONE of these headers
// (all `cf-cache-status: HIT`, `cfOrigin;dur=0`), while all 8 worker-served
// paths carried all five.
//
// So the document itself has no CSP -- the one place CSP does anything. This is
// structural, not a stale cache: a purge changes nothing.
//
// `run_worker_first = ["/"]` fixes it, measured against `wrangler dev` on
// 18 Sep 2026 (table in CLAUDE.md). It is enough because `/` is the ONLY
// document the asset store can answer: `index.html` is the single HTML file in
// `dist/client`, `/index.html` 307s to `/`, and every other route (`/about`,
// `/feed/2`, ...) matches no file, so it already arrives here and is already
// wrapped. `run_worker_first = true` also works but additionally routes the JS,
// CSS, fonts and locale JSON through the Worker, where these headers do nothing
// -- CSP and X-Frame-Options are enforced per document, not per subresource.
//
// `run_worker_first` as an array IS an allowlist, and scoping one to document
// paths served `index.html` in place of every `/api/` response in
// ears-pearcache. That does not happen here and the difference is worth
// knowing: that repo sets `not_found_handling`, so an unmatched path was
// answered by the asset store; this config sets none, so an unmatched path
// falls through to the Worker. Verified, not assumed -- `/api/feed` and
// `/api/user/profile` both still returned `application/json` under `["/"]`.
//
// `["/"]` is set by `buildWranglerAssetsConfig()` in
// `cli/src/tasks/deploy-cf.ts`, which GENERATES `wrangler.toml` -- editing that
// file directly is discarded on the next deploy.
//
// Deployed and CONFIRMED live on 18 Sep 2026: a browser HAR of `/` carries all
// five of these headers, and the CSP byte-matches the constant below.
//
// One trap that this fix created. `cf-cache-status: HIT` is STILL on `/`, because
// `withSecurityHeaders` copies every header off the internal
// `env.ASSETS.fetch()` response, including that one. It no longer means the
// Worker was bypassed. The signal that does distinguish the two is
// `server-timing`: before the fix `/` carried `cfCacheStatus;desc="HIT"` and
// `cfEdge;dur=10,cfOrigin;dur=0`; after it, only `cfExtPri`. Do not re-diagnose
// this from `cf-cache-status` alone -- reading it that way is what made this look
// like a stale edge cache for the first half of the investigation.
//
// script-src 'self' is the load-bearing directive: the built index.html loads
// two external, same-origin scripts and no inline ones, so no hash or nonce is
// needed. NOTE this does block the admin "custom footer HTML" feature's inline
// <script> injection (client/src/components/footer.tsx); if that is ever used
// for an analytics snippet, add that origin here rather than widening to
// 'unsafe-inline'.
//
// style-src keeps 'unsafe-inline' because react-syntax-highlighter and the
// lightbox apply style="" attributes at runtime. Inline CSS cannot execute
// script, so this is a far smaller concession than the script-src equivalent.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "media-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Redundant with frame-ancestors for modern browsers, kept for old ones.
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

// Responses from env.ASSETS.fetch() are immutable, so the headers are copied
// into a new Response rather than mutated in place.
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleFetch(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
): Promise<Response> {
  return withSecurityHeaders(await route(request, env, executionContext));
}

async function route(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env, executionContext);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isMetaRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return asset;
    }
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    return indexResponse;
  }

  return new Response("Hi", { status: 200 });
}
