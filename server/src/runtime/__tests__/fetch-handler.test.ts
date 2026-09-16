import { afterEach, describe, expect, it, mock } from "bun:test";

const getAppFetch = mock();

mock.module("../app-instance", () => ({
  getApp: () => ({
    fetch: getAppFetch,
  }),
}));

describe("handleFetch", () => {
  afterEach(() => {
    getAppFetch.mockReset();
  });

  it("serves static assets directly when the asset exists", async () => {
    getAppFetch.mockResolvedValue(new Response("app-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 200 }));

    const response = await handleFetch(
      new Request("http://localhost/assets/app.js"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(await response.text()).toBe("asset-body");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(getAppFetch).toHaveBeenCalledTimes(0);
  });

  it("routes /api/blob requests to the app before static assets", async () => {
    getAppFetch.mockResolvedValue(new Response("blob-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 404 }));

    const executionContext = {} as ExecutionContext;
    const response = await handleFetch(
      new Request("http://localhost/api/blob/images/test.txt"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
      executionContext,
    );

    expect(await response.text()).toBe("blob-body");
    expect(getAppFetch).toHaveBeenCalledTimes(1);
    expect(assetFetch).toHaveBeenCalledTimes(0);
    expect(new URL(getAppFetch.mock.calls[0][0].url).pathname).toBe("/blob/images/test.txt");
    expect(getAppFetch.mock.calls[0][2]).toBe(executionContext);
  });
});

describe("security headers", () => {
  afterEach(() => {
    getAppFetch.mockReset();
  });

  const env = (assetStatus: number) => ({
    ASSETS: { fetch: mock(async () => new Response("asset-body", { status: assetStatus })) },
  }) as any;

  // Rin serves API, static assets and the SPA entry from three different
  // branches. The headers are only worth anything if they cover all three, so
  // each branch is checked rather than just the one that is easiest to reach.
  it.each([
    ["static asset", "http://localhost/assets/app.js", 200],
    ["api route", "http://localhost/api/comment/1", 404],
    ["spa entry", "http://localhost/feed/1", 200],
  ])("sets the headers on a %s response", async (_label, url, assetStatus) => {
    getAppFetch.mockResolvedValue(new Response("app-body", { status: 200 }));
    const { handleFetch, SECURITY_HEADERS } = await import("../fetch-handler");

    const response = await handleFetch(new Request(url), env(assetStatus));

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  // The failure mode this guards against is someone loosening script-src to
  // make an inline snippet work. That silently removes the only directive here
  // standing between a future injection and script execution, and nothing else
  // would go red.
  it("keeps script-src free of unsafe-inline and unsafe-eval", async () => {
    const { SECURITY_HEADERS } = await import("../fetch-handler");
    const csp = SECURITY_HEADERS["Content-Security-Policy"];

    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'self'");

    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
