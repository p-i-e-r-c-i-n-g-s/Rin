import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { apiCors, corsAllowOrigin } from "./register-middlewares";

const BLOG = "https://blog.example.com";

function createApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", apiCors);
    app.get("/feed", (c) => c.text("ok"));
    return app;
}

function get(origin: string, { url = `${BLOG}/feed`, frontendUrl = BLOG as string | undefined } = {}) {
    return createApp().request(url, { headers: { Origin: origin } }, { FRONTEND_URL: frontendUrl } as unknown as Env);
}

function preflight(origin: string) {
    return createApp().request(`${BLOG}/feed`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    }, { FRONTEND_URL: BLOG } as unknown as Env);
}

describe("API CORS", () => {
    it("gives a foreign origin no Access-Control-Allow-Origin", async () => {
        const res = await get("https://evil.example");
        expect(res.headers.get("access-control-allow-origin")).toBeNull();

        const pre = await preflight("https://evil.example");
        expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("refuses a same-site sibling host, which SameSite=Lax would send the cookie from", async () => {
        const res = await get("https://other.example.com");
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows the blog's own origin, with credentials", async () => {
        const res = await get(BLOG);
        expect(res.headers.get("access-control-allow-origin")).toBe(BLOG);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toContain("Origin");

        const pre = await preflight(BLOG);
        expect(pre.headers.get("access-control-allow-origin")).toBe(BLOG);
    });

    it("matches FRONTEND_URL by origin, ignoring a path, trailing slash or padding", () => {
        expect(corsAllowOrigin(BLOG, `  ${BLOG}/  `, `${BLOG}/api/feed`)).toBe(BLOG);
        expect(corsAllowOrigin(BLOG, `${BLOG}/blog`, `${BLOG}/api/feed`)).toBe(BLOG);
        expect(corsAllowOrigin("http://blog.example.com", BLOG, `${BLOG}/api/feed`)).toBeNull();
        expect(corsAllowOrigin(`${BLOG}:8443`, BLOG, `${BLOG}/api/feed`)).toBeNull();
    });

    it("refuses Origin: null, whatever FRONTEND_URL holds", () => {
        expect(corsAllowOrigin("null", BLOG, `${BLOG}/api/feed`)).toBeNull();
        expect(corsAllowOrigin("null", "not a url", `${BLOG}/api/feed`)).toBeNull();
        // new URL("data:,x").origin is the string "null"; it must not become a match.
        expect(corsAllowOrigin("null", "data:,x", `${BLOG}/api/feed`)).toBeNull();
    });

    it("allows nothing cross-origin when FRONTEND_URL is unset", async () => {
        const res = await get("https://evil.example", { frontendUrl: undefined });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows localhost only when the Worker itself runs on loopback (wrangler dev)", async () => {
        const production = await get("http://localhost:5173");
        expect(production.headers.get("access-control-allow-origin")).toBeNull();

        const dev = await get("http://localhost:5173", { url: "http://127.0.0.1:11499/feed", frontendUrl: undefined });
        expect(dev.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

        const devForeign = await get("https://evil.example", { url: "http://127.0.0.1:11499/feed", frontendUrl: undefined });
        expect(devForeign.headers.get("access-control-allow-origin")).toBeNull();
    });
});
