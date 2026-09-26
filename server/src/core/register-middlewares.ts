import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { authMiddleware, initContainerMiddleware } from "./hono-middleware";
import type { RinApp } from "./app-types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function httpUrl(value: string | undefined) {
  try {
    const url = new URL((value ?? "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// The only origin allowed to read API responses cross-origin, with the auth
// cookie, is the blog's own (FRONTEND_URL). This used to reflect any Origin
// with credentials, and SameSite=Lax does not stop that: every other
// *.pearcache.com host is same-site, so the browser sends the cookie from it.
// The SPA itself calls the API same-origin and needs no CORS at all.
//
// Loopback origins are allowed only when the Worker itself is answering on
// loopback, i.e. `wrangler dev`. In production the request URL is the blog's
// hostname, so this can never open the deployed API to a localhost page.
export function corsAllowOrigin(origin: string, frontendUrl: string | undefined, requestUrl: string) {
  const requested = httpUrl(origin);
  if (!requested) {
    return null;
  }

  const frontend = httpUrl(frontendUrl);
  if (frontend && requested.origin === frontend.origin) {
    return requested.origin;
  }

  const self = httpUrl(requestUrl);
  if (self && LOOPBACK_HOSTS.has(self.hostname) && LOOPBACK_HOSTS.has(requested.hostname)) {
    return requested.origin;
  }

  return null;
}

export const apiCors = cors({
  origin: (origin, c) => corsAllowOrigin(origin, c.env?.FRONTEND_URL, c.req.url),
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["content-type", "authorization", "x-csrf-token"],
  maxAge: 600,
  credentials: true,
});

export function registerMiddlewares(app: RinApp) {
  app.use("*", apiCors);

  app.use("*", timing({ totalDescription: "" }));
  app.use("*", initContainerMiddleware);
  app.use("*", authMiddleware);
}
