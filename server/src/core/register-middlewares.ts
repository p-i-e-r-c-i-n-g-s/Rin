import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { authMiddleware, initContainerMiddleware } from "./hono-middleware";
import type { RinApp } from "./app-types";

// Which Origin may read responses cross-origin, with credentials. Upstream
// reflected every Origin back, which with `credentials: true` lets any site a
// signed-in visitor opens read the API as that visitor (the auth cookie is
// SameSite=Lax, so it rides on a cross-site fetch between sibling subdomains).
// Nothing legitimate needs cross-origin access: the client calls the API on its
// own origin (`endpoint = ''` in client/src/config.ts) and the Vite dev server
// proxies /api. So only FRONTEND_URL's own origin is allowed, and with it unset,
// none is. Same-origin requests need no CORS header and are unaffected.
export function allowedCorsOrigin(origin: string, frontendUrl: string | undefined): string | null {
  if (!origin || !frontendUrl?.trim()) return null;
  try {
    return new URL(frontendUrl.trim()).origin === origin ? origin : null;
  } catch {
    return null;
  }
}

export function registerMiddlewares(app: RinApp) {
  app.use(
    "*",
    cors({
      origin: (origin, c) => allowedCorsOrigin(origin, c.env?.FRONTEND_URL),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-csrf-token"],
      maxAge: 600,
      credentials: true,
    }),
  );

  app.use("*", timing({ totalDescription: "" }));
  app.use("*", initContainerMiddleware);
  app.use("*", authMiddleware);
}
