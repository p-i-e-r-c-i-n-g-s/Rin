import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TagService, bindTagToPost } from '../tag';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, seedTestData, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

// seedTestData makes user 2 the admin; the fixture maps this token to user 2.
const ADMIN = { Authorization: 'Bearer mock_token_2' };

describe('TagService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;

    beforeEach(async () => {
        const ctx = await setupTestApp(TagService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        
        // Seed test data
        seedTestData(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    describe('GET / - List all tags', () => {
        it('should return all tags with feed counts', async () => {
            const res = await app.request('/', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toBeArray();
            expect(data.length).toBe(2);
            
            const testTag = data.find((t: any) => t.name === 'test');
            expect(testTag).toBeDefined();
            expect(testTag.feeds).toBe(2);
            
            const integrationTag = data.find((t: any) => t.name === 'integration');
            expect(integrationTag).toBeDefined();
            expect(integrationTag.feeds).toBe(1);
        });

        it('should count only public posts, and hide tags with none, for non-admins', async () => {
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (3, 'Draft', 'Content', 1, 1, 1)`);
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (4, 'Unlisted', 'Content', 1, 0, 0)`);
            sqlite.exec(`INSERT INTO hashtags (id, name) VALUES (3, 'secret-project')`);
            sqlite.exec(`INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (3, 1), (4, 1), (3, 3), (4, 3)`);

            const res = await app.request('/', { method: 'GET' }, env);
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.map((t: any) => [t.name, t.feeds]).sort()).toEqual([['integration', 1], ['test', 2]]);

            const adminRes = await app.request('/', { method: 'GET', headers: ADMIN }, env);
            const adminData = await adminRes.json() as any;
            expect(adminData.map((t: any) => [t.name, t.feeds]).sort()).toEqual([['integration', 1], ['secret-project', 2], ['test', 4]]);
        });

        it('should return empty array when no tags exist', async () => {
            sqlite.exec('DELETE FROM feed_hashtags');
            sqlite.exec('DELETE FROM hashtags');
            
            const res = await app.request('/', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toEqual([]);
        });
    });

    describe('GET /:name - Get tag details', () => {
        it('should return tag with feeds', async () => {
            const res = await app.request('/test', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.name).toBe('test');
            expect(data.feeds).toBeArray();
            expect(data.feeds.length).toBe(2);
        });

        it('should decode URL-encoded tag names', async () => {
            sqlite.exec(`INSERT INTO hashtags (id, name) VALUES (3, 'web dev')`);
            sqlite.exec(`INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (1, 3)`);
            
            const res = await app.request('/web%20dev', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.name).toBe('web dev');
        });

        it('should look up a tag containing % instead of failing with a 500', async () => {
            sqlite.exec(`INSERT INTO hashtags (id, name) VALUES (3, '100%')`);
            sqlite.exec(`INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (1, 3)`);

            // encodeURIComponent('100%'). Hono decodes it once; a second
            // decodeURI threw URIError on the bare '%'.
            const res = await app.request('/100%25', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.name).toBe('100%');
        });

        it('should return 404 for non-existent tag', async () => {
            const res = await app.request('/nonexistent', { method: 'GET' }, env);
            
            expect(res.status).toBe(404);
        });

        it('should exclude draft and unlisted feeds for non-admin users', async () => {
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (3, 'Draft', 'Content', 1, 1, 1)`);
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (4, 'Unlisted', 'Content', 1, 0, 0)`);
            sqlite.exec(`INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (3, 1), (4, 1)`);
            
            // Asserted by id. The response selects no draft column, so the old
            // check (every feed has draft !== 1) passed whatever came back.
            const res = await app.request('/test', { method: 'GET' }, env);
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.feeds.map((f: any) => f.id).sort()).toEqual([1, 2]);

            const adminRes = await app.request('/test', { method: 'GET', headers: ADMIN }, env);
            const adminData = await adminRes.json() as any;
            expect(adminData.feeds.map((f: any) => f.id).sort()).toEqual([1, 2, 3, 4]);
        });

        it('should 404 for non-admins on a tag used only by draft or unlisted posts', async () => {
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (3, 'Draft', 'Content', 1, 1, 1)`);
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (4, 'Unlisted', 'Content', 1, 0, 0)`);
            sqlite.exec(`INSERT INTO hashtags (id, name) VALUES (3, 'secret-project')`);
            sqlite.exec(`INSERT INTO feed_hashtags (feed_id, hashtag_id) VALUES (3, 3), (4, 3)`);

            // A 200 with an empty feed list confirmed the hidden tag exists.
            // Anonymous callers must get the same answer as for a tag that
            // never existed.
            const res = await app.request('/secret-project', { method: 'GET' }, env);
            expect(res.status).toBe(404);
            expect(await res.text()).toBe('Not found');

            const adminRes = await app.request('/secret-project', { method: 'GET', headers: ADMIN }, env);
            expect(adminRes.status).toBe(200);
            const adminData = await adminRes.json() as any;
            expect(adminData.name).toBe('secret-project');
            expect(adminData.feeds.map((f: any) => f.id).sort()).toEqual([3, 4]);
        });

        it('should include hashtags in feed data', async () => {
            const res = await app.request('/test', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.feeds.length).toBeGreaterThan(0);
            expect(data.feeds[0].hashtags).toBeArray();
        });
    });

    describe('bindTagToPost function', () => {
        it('should bind tags to a feed', async () => {
            await bindTagToPost(db, 1, ['newtag1', 'newtag2']);
            
            const result = sqlite.prepare(`
                SELECT h.name FROM hashtags h
                JOIN feed_hashtags fh ON h.id = fh.hashtag_id
                WHERE fh.feed_id = 1
            `).all();
            
            expect(result.length).toBeGreaterThan(0);
        });

        it('should create new tags if they do not exist', async () => {
            await bindTagToPost(db, 1, ['brandnewtag']);
            
            const tagResult = sqlite.prepare(`
                SELECT * FROM hashtags WHERE name = 'brandnewtag'
            `).all();
            
            expect(tagResult.length).toBe(1);
        });

        it('should remove existing tags before binding new ones', async () => {
            await bindTagToPost(db, 1, ['tag1', 'tag2']);
            await bindTagToPost(db, 1, ['tag3']);
            
            const result = sqlite.prepare(`
                SELECT h.name FROM hashtags h
                JOIN feed_hashtags fh ON h.id = fh.hashtag_id
                WHERE fh.feed_id = 1
            `).all();
            
            const tagNames = result.map((r: any) => r.name);
            expect(tagNames).not.toContain('tag1');
            expect(tagNames).not.toContain('tag2');
            expect(tagNames).toContain('tag3');
        });

        it('should reuse existing tags', async () => {
            await bindTagToPost(db, 1, ['reusable']);
            
            const tagResult = sqlite.prepare(`SELECT id FROM hashtags WHERE name = 'reusable'`).all() as any[];
            const tagId = tagResult[0]?.id;
            
            await bindTagToPost(db, 2, ['reusable']);
            
            const feed2Tags = sqlite.prepare(`
                SELECT hashtag_id FROM feed_hashtags WHERE feed_id = 2
            `).all() as any[];
            
            expect(feed2Tags[0]?.hashtag_id).toBe(tagId);
        });

        it('should handle empty tags array', async () => {
            await bindTagToPost(db, 1, ['tag1', 'tag2']);
            await bindTagToPost(db, 1, []);
            
            const result = sqlite.prepare(`
                SELECT COUNT(*) as count FROM feed_hashtags WHERE feed_id = 1
            `).all() as any[];
            
            expect(result[0]?.count).toBe(0);
        });
    });
});
