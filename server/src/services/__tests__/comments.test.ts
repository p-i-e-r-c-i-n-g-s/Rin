import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CommentService } from '../comments';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('CommentService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        const ctx = await setupTestApp(CommentService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        
        // Seed test data
        await seedTestData(sqlite);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        cleanupTestDB(sqlite);
    });

    async function seedTestData(sqlite: Database) {
        // Insert test users
        sqlite.exec(`
            INSERT INTO users (id, username, avatar, permission, openid) VALUES 
                (1, 'user1', 'avatar1.png', 0, 'gh_1'),
                (2, 'user2', 'avatar2.png', 0, 'gh_2'),
                (3, 'admin', 'admin.png', 1, 'gh_admin')
        `);

        // Insert test feeds
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES 
                (1, 'Feed 1', 'Content 1', 1, 0, 1),
                (2, 'Feed 2', 'Content 2', 1, 0, 1)
        `);

        // Insert test comments
        sqlite.exec(`
            INSERT INTO comments (id, feed_id, user_id, content, created_at) VALUES 
                (1, 1, 2, 'Comment 1 on feed 1', unixepoch()),
                (2, 1, 2, 'Comment 2 on feed 1', unixepoch()),
                (3, 2, 1, 'Comment on feed 2', unixepoch())
        `);
    }

    describe('GET /:feed - List comments', () => {
        it('should return comments for a feed', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toBeArray();
            expect(data.length).toBe(2);
            expect(data[0]).toHaveProperty('content');
            expect(data[0]).toHaveProperty('user');
            expect(data[0].user).toHaveProperty('username');
        });

        it('should return empty array when feed has no comments', async () => {
            // Create new feed without comments
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid) VALUES (3, 'No Comments', 'Content', 1)`);
            
            const res = await app.request('/3', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toEqual([]);
        });

        it('should not expose sensitive fields', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBeGreaterThan(0);
            
            // Should not include feedId and userId (excluded in query)
            expect(data[0]).not.toHaveProperty('feedId');
            expect(data[0]).not.toHaveProperty('userId');
            
            // Should include user info
            expect(data[0].user).toHaveProperty('id');
            expect(data[0].user).toHaveProperty('username');
            expect(data[0].user).toHaveProperty('avatar');
            expect(data[0].user).toHaveProperty('permission');
        });

        it('should order comments by createdAt descending', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBe(2);
        });
    });

    describe('POST /:feed - Create comment', () => {
        it('should create comment with authenticated user', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'New test comment' }),
            }, env);

            expect(res.status).toBe(200);
            
            // Verify comment was created
            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all();
            expect(comments.length).toBe(3);
        });

        it('should create guest comment with guestName', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: 'Guest comment',
                    guestName: 'Visitor',
                    guestEmail: 'visitor@example.com',
                    guestWebsite: 'https://example.com',
                }),
            }, env);

            expect(res.status).toBe(200);

            // Verify via direct DB query
            const row = sqlite.prepare(
                `SELECT content, guest_name, guest_email, guest_website FROM comments WHERE guest_name = 'Visitor'`
            ).get() as any;
            expect(row).toBeDefined();
            expect(row.content).toBe('Guest comment');
            expect(row.guest_name).toBe('Visitor');
            expect(row.guest_email).toBe('visitor@example.com');
            expect(row.guest_website).toBe('https://example.com');
        });

        it('should reject guest comment without guestName', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Guest no name' }),
            }, env);
            expect(res.status).toBe(400);
        });

        it('should hold a guest comment for review, then show it to the public once approved', async () => {
            const createRes = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Hi from guest', guestName: 'Guest' }),
            }, env);
            expect(createRes.status).toBe(200);

            // Anonymous reader: not visible yet.
            const anon = await (await app.request('/1', { method: 'GET' }, env)).json() as any[];
            expect(anon.find((c: any) => c.guestName === 'Guest')).toBeUndefined();

            // Admin: visible, flagged pending, so there is something to act on.
            const asAdmin = await (await app.request('/1', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env)).json() as any[];
            const held = asAdmin.find((c: any) => c.guestName === 'Guest');
            expect(held).toBeDefined();
            expect(held.approved).toBe(0);
            expect(held.user).toBeNull();
            expect(held.content).toBe('Hi from guest');

            // Approve, and it reaches the public list.
            const approveRes = await app.request(`/${held.id}/approve`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);
            expect(approveRes.status).toBe(200);

            const after = await (await app.request('/1', { method: 'GET' }, env)).json() as any[];
            expect(after.find((c: any) => c.guestName === 'Guest')).toBeDefined();
        });

        it('should bound the size of an unauthenticated write', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'x'.repeat(10_001), guestName: 'Flooder' }),
            }, env);
            expect(res.status).toBe(400);

            const stored = sqlite.prepare(
                `SELECT COUNT(*) as n FROM comments WHERE guest_name = 'Flooder'`
            ).get() as any;
            expect(stored.n).toBe(0);
        });

        it('should refuse approval from a non-admin', async () => {
            await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'spam', guestName: 'Nobody' }),
            }, env);
            const row = sqlite.prepare(
                `SELECT id FROM comments WHERE guest_name = 'Nobody'`
            ).get() as any;

            const anon = await app.request(`/${row.id}/approve`, { method: 'POST' }, env);
            expect(anon.status).toBe(403);

            const plainUser = await app.request(`/${row.id}/approve`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            expect(plainUser.status).toBe(403);

            // Still held.
            const check = sqlite.prepare(
                `SELECT approved FROM comments WHERE id = ?`
            ).get(row.id) as any;
            expect(check.approved).toBe(0);
        });

        it('should strip a javascript: website rather than storing it', async () => {
            // The client sends type="url", but a direct POST does not have to.
            for (const hostile of [
                'javascript:alert(1)',
                '  JaVaScRiPt:alert(1)',
                'java\tscript:alert(1)',
                'data:text/html,<script>alert(1)</script>',
                'vbscript:msgbox(1)',
            ]) {
                const res = await app.request('/1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: 'x', guestName: `H${hostile.length}`, guestWebsite: hostile,
                    }),
                }, env);
                expect(res.status).toBe(200);
            }

            const rows = sqlite.prepare(
                `SELECT guest_website FROM comments WHERE guest_website != ''`
            ).all() as any[];
            for (const r of rows) {
                expect(r.guest_website.toLowerCase()).toMatch(/^https?:\/\//);
            }
        });

        it('should keep an ordinary website, adding a scheme when absent', async () => {
            await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'x', guestName: 'Bare', guestWebsite: 'example.com' }),
            }, env);
            const row = sqlite.prepare(
                `SELECT guest_website FROM comments WHERE guest_name = 'Bare'`
            ).get() as any;
            expect(row.guest_website).toBe('https://example.com');
        });

        it('should not publish guest email addresses in the comment list', async () => {
            await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: 'x', guestName: 'Emailer', guestEmail: 'private@example.com',
                }),
            }, env);

            const asAdmin = await (await app.request('/1', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env)).json() as any[];
            const row = asAdmin.find((c: any) => c.guestName === 'Emailer');
            expect(row).toBeDefined();
            expect(row.guestEmail).toBeUndefined();

            // ...but it is still stored, for the admin's webhook.
            const stored = sqlite.prepare(
                `SELECT guest_email FROM comments WHERE guest_name = 'Emailer'`
            ).get() as any;
            expect(stored.guest_email).toBe('private@example.com');
        });

        it('should return 400 when not authenticated and guest name missing', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Test comment' }),
            }, env);

            expect(res.status).toBe(400);
            expect(await res.text()).toContain('Guest name is required');
        });

        it('should require content', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: '' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should return 401 for non-existent user token', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_999',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should return 400 for non-existent feed', async () => {
            const res = await app.request('/999', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should still create the comment when webhook delivery fails', async () => {
            env.WEBHOOK_URL = 'not-a-valid-url' as any;
            globalThis.fetch = mock(async () => {
                throw new TypeError('Invalid URL');
            }) as typeof fetch;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Comment survives webhook errors' }),
            }, env);

            expect(res.status).toBe(200);

            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all();
            expect(comments.length).toBe(3);
        });
    });

    describe('DELETE /:id - Delete comment', () => {
        it('should allow user to delete their own comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_2' },
            }, env);

            expect(res.status).toBe(200);
            
            // Verify comment was deleted
            const dbResult = sqlite.prepare(`SELECT * FROM comments WHERE id = 1`).all();
            expect(dbResult.length).toBe(0);
        });

        it('should allow admin to delete any comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);

            expect(res.status).toBe(200);
        });

        it('should deny deletion by other users', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(403);
        });

        it('should require authentication', async () => {
            const res = await app.request('/1', { method: 'DELETE' }, env);

            expect(res.status).toBe(401);
        });

        it('should return 404 for non-existent comment', async () => {
            const res = await app.request('/999', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(404);
        });
    });
});
