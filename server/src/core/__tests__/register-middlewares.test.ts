import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { allowedCorsOrigin } from "../register-middlewares";

describe("allowedCorsOrigin", () => {
  const site = "https://blog.example.com";

  it("allows only FRONTEND_URL's own origin", () => {
    expect(allowedCorsOrigin(site, site)).toBe(site);
    expect(allowedCorsOrigin(site, `${site}/`)).toBe(site);
    expect(allowedCorsOrigin(site, `${site}/some/path`)).toBe(site);
  });

  it("refuses any other origin, including sibling subdomains and look-alikes", () => {
    expect(allowedCorsOrigin("https://evil.example", site)).toBeNull();
    expect(allowedCorsOrigin("https://images.example.com", site)).toBeNull();
    expect(allowedCorsOrigin("https://blog.example.com.evil.example", site)).toBeNull();
    expect(allowedCorsOrigin("http://blog.example.com", site)).toBeNull();
    expect(allowedCorsOrigin("null", site)).toBeNull();
  });

  it("refuses everything when FRONTEND_URL is unset or unparseable", () => {
    expect(allowedCorsOrigin(site, undefined)).toBeNull();
    expect(allowedCorsOrigin(site, "")).toBeNull();
    expect(allowedCorsOrigin(site, "not a url")).toBeNull();
  });

  it("sends no Access-Control-Allow-Origin to a foreign origin through the real middleware", async () => {
    const app = new Hono<{ Bindings: { FRONTEND_URL?: string } }>();
    app.use("*", cors({
      origin: (origin, c) => allowedCorsOrigin(origin, c.env?.FRONTEND_URL),
      credentials: true,
    }));
    app.get("/api/x", (c) => c.json({ ok: true }));
    const env = { FRONTEND_URL: site };

    const foreign = await app.request("/api/x", { headers: { Origin: "https://evil.example" } }, env);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const own = await app.request("/api/x", { headers: { Origin: site } }, env);
    expect(own.headers.get("access-control-allow-origin")).toBe(site);
  });
});
