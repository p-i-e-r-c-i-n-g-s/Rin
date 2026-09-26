import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { feeds } from "../../db/schema";
import { cleanupTestDB, createTestUser, setupTestApp, type TestCacheImpl } from "../../../tests/fixtures";
import { SearchService } from "../feed";

describe("SearchService", () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let clientConfig: TestCacheImpl;

    beforeEach(async () => {
        const context = await setupTestApp(SearchService);
        db = context.db;
        sqlite = context.sqlite;
        env = context.env;
        app = context.app;
        clientConfig = context.clientConfig;
        await createTestUser(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it("paginates matching feeds in the database while preserving the response shape", async () => {
        await db.insert(feeds).values([
            { title: "Needle 1", content: "one", uid: 1, draft: 0, listed: 1 },
            { title: "Needle 2", content: "two", uid: 1, draft: 0, listed: 1 },
            { title: "Needle 3", content: "three", uid: 1, draft: 0, listed: 1 },
        ]);

        const firstResponse = await app.request("/Needle?page=1&limit=2", {}, env);
        const firstPage = await firstResponse.json() as any;

        expect(firstResponse.status).toBe(200);
        expect(firstPage.size).toBe(3);
        expect(firstPage.data).toHaveLength(2);
        expect(firstPage.hasNext).toBe(true);

        const secondResponse = await app.request("/Needle?page=2&limit=2", {}, env);
        const secondPage = await secondResponse.json() as any;

        expect(secondResponse.status).toBe(200);
        expect(secondPage.size).toBe(3);
        expect(secondPage.data).toHaveLength(1);
        expect(secondPage.hasNext).toBe(false);
    });

    it("searches for a literal % instead of failing with a 500", async () => {
        await db.insert(feeds).values([
            { title: "Uptime 100% guaranteed", content: "sla", uid: 1, draft: 0, listed: 1 },
        ]);

        // The client sends encodeURIComponent("100%"). Hono already decodes the
        // param once; a second decodeURI threw URIError on the bare "%".
        const response = await app.request("/100%25", {}, env);

        expect(response.status).toBe(200);
        const result = await response.json() as any;
        expect(result.data.map((feed: any) => feed.title)).toEqual(["Uptime 100% guaranteed"]);
    });

    it("treats _ and % in the keyword as literal characters", async () => {
        await db.insert(feeds).values([
            { title: "Needle snake_case", content: "underscore", uid: 1, draft: 0, listed: 1 },
            { title: "Needle snakeXcase", content: "not an underscore", uid: 1, draft: 0, listed: 1 },
        ]);

        // Without ESCAPE the backslash-escaped pattern matched nothing at all;
        // unescaped, "_" would also match the X.
        const response = await app.request("/snake_case", {}, env);
        const result = await response.json() as any;
        expect(result.data.map((feed: any) => feed.title)).toEqual(["Needle snake_case"]);

        const percent = await app.request("/snake%25case", {}, env);
        expect((await percent.json() as any).size).toBe(0);
    });

    it("does not decode the keyword twice", async () => {
        await db.insert(feeds).values([
            { title: "Needle 50 off", content: "decoded twice", uid: 1, draft: 0, listed: 1 },
        ]);

        // encodeURIComponent("50%20off"): a second decode turned it into "50 off".
        const response = await app.request("/50%2520off", {}, env);

        expect(response.status).toBe(200);
        const result = await response.json() as any;
        expect(result.size).toBe(0);
    });

    it("never returns unlisted posts to anonymous search, but does to admins", async () => {
        await db.insert(feeds).values([
            { title: "Needle listed", content: "public", uid: 1, draft: 0, listed: 1 },
            { title: "Needle unlisted", content: "link-only", uid: 1, draft: 0, listed: 0 },
            { title: "Needle draft", content: "private", uid: 1, draft: 1, listed: 1 },
        ]);

        const publicResponse = await app.request("/Needle", {}, env);
        const publicResult = await publicResponse.json() as any;

        expect(publicResponse.status).toBe(200);
        expect(publicResult.size).toBe(1);
        expect(publicResult.data.map((feed: any) => feed.title)).toEqual(["Needle listed"]);

        const adminResponse = await app.request("/Needle", {
            headers: { Authorization: "Bearer mock_token_1" },
        }, env);
        const adminResult = await adminResponse.json() as any;
        expect(adminResult.size).toBe(3);
    });

    it("isolates administrator search cache entries from public results", async () => {
        await clientConfig.set("cache.enabled", true);
        await db.insert(feeds).values([
            { title: "Shared result", content: "visible", uid: 1, draft: 0, listed: 1 },
            { title: "Shared draft", content: "private", uid: 1, draft: 1, listed: 1 },
        ]);

        const adminResponse = await app.request("/Shared", {
            headers: { Authorization: "Bearer mock_token_1" },
        }, env);
        const adminResult = await adminResponse.json() as any;
        expect(adminResult.size).toBe(2);

        const publicResponse = await app.request("/Shared", {}, env);
        const publicResult = await publicResponse.json() as any;

        expect(publicResponse.status).toBe(200);
        expect(publicResult.size).toBe(1);
        expect(publicResult.data).toHaveLength(1);
        expect(publicResult.data[0].title).toBe("Shared result");
    });
});
