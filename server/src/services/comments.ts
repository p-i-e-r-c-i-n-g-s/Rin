import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { and, desc, eq } from "drizzle-orm";
import { comments, feeds, users } from "../db/schema";
import { profileAsync } from "../core/server-timing";
import { notify } from "../utils/webhook";
import { resolveWebhookConfig } from "./config-helpers";

// A guest-supplied website is rendered straight into an <a href>. Any scheme
// other than http(s) -- javascript: above all -- makes that anchor a
// script-execution sink for whoever clicks it, and the commenter needs no
// account to store one. The scheme is therefore allowlisted on the way IN,
// where it is authoritative: the client's <input type="url"> is a UX hint that
// a direct POST to this endpoint ignores entirely.
//
// Parsed with the platform URL parser rather than matched with a regex,
// deliberately: URL normalises case and strips the tab/newline padding
// ("java\tscript:") exactly the way a browser does when it resolves the href,
// so what is validated here and what the browser executes cannot disagree.
// Generous enough that no real comment hits them, small enough that the
// endpoint cannot be used to fill the database.
const MAX_CONTENT = 10_000;
const MAX_FIELD = 200;

export function safeWebsite(raw: unknown): string {
    if (typeof raw !== "string") return "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_FIELD) return "";
    // Bare "example.com" has no scheme and would otherwise be dropped silently.
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const { protocol } = new URL(candidate);
        return protocol === "http:" || protocol === "https:" ? candidate : "";
    } catch {
        return "";
    }
}

// Guest comments are held for review by default. Set `comment.guest.approval`
// to false to publish them on arrival (the upstream behaviour).
async function requiresApproval(serverConfig: any): Promise<boolean> {
    try {
        return await serverConfig.getOrDefault("comment.guest.approval", true);
    } catch {
        return true; // fail closed: a config read that errors must not auto-publish
    }
}

export function CommentService(): Hono {
    const app = new Hono();

    app.get('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const admin = c.get('admin');
        const feedId = parseInt(c.req.param('feed'));

        // Admins see pending comments so they have something to approve; every
        // other caller -- signed out, signed in, or the RSS crawler -- sees only
        // what has been approved.
        const visible = admin
            ? eq(comments.feedId, feedId)
            : and(eq(comments.feedId, feedId), eq(comments.approved, 1));

        const comment_list = await profileAsync(c, 'comment_list_db', () => db.query.comments.findMany({
            where: visible,
            columns: { feedId: false, userId: false },
            with: {
                user: {
                    columns: { id: true, username: true, avatar: true, permission: true }
                }
            },
            orderBy: [desc(comments.createdAt)]
        }));
        
        // 将结果统一为前端兼容格式：登录用户用 user 字段，游客用 guestName 等
        const result = comment_list.map((c: any) => {
            if (c.user) {
                // 登录用户的评论
                return c;
            }
            // 游客评论：去掉空的 user 字段，保留 guestName 等
            // guestEmail is deliberately NOT spread out to the client. It is
            // collected for the admin's notification webhook, not for display,
            // and echoing it here published every commenter's address to anyone
            // who opened the post.
            const { user, guestEmail: _guestEmail, ...rest } = c;
            return {
                ...rest,
                user: null,
                guestName: rest.guestName || "",
                guestWebsite: safeWebsite(rest.guestWebsite),
            };
        });
        
        return c.json(result);
    });

    app.post('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const env = c.get('env');
        const serverConfig = c.get('serverConfig');
        const uid = c.get('uid');
        const feedId = parseInt(c.req.param('feed'));
        const body = await profileAsync(c, 'comment_create_parse', () => c.req.json());
        const { content, guestName, guestEmail, guestWebsite } = body;
        
        if (!content) {
            return c.text('Content is required', 400);
        }

        // Anyone can reach this route without an account, so the write is
        // bounded here. Without a cap a single unauthenticated POST can put an
        // arbitrarily large row in D1, and nothing downstream would refuse it.
        if (typeof content !== 'string' || content.length > MAX_CONTENT) {
            return c.text('Content is too long', 400);
        }
        if (typeof guestName === 'string' && guestName.length > MAX_FIELD) {
            return c.text('Guest name is too long', 400);
        }
        
        const exist = await profileAsync(c, 'comment_create_feed', () => db.query.feeds.findFirst({ where: eq(feeds.id, feedId) }));
        if (!exist) {
            return c.text('Feed not found', 400);
        }

        // 登录用户评论
        if (uid) {
            const user = await profileAsync(c, 'comment_create_user', () => db.query.users.findFirst({ where: eq(users.id, uid) }));
            if (!user) {
                return c.text('User not found', 400);
            }

            await db.insert(comments).values({
                feedId,
                userId: uid,
                content
            });

            const { webhookUrl, webhookMethod, webhookContentType, webhookHeaders, webhookBodyTemplate } =
                await profileAsync(c, 'comment_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
            const frontendUrl = new URL(c.req.url).origin;
            try {
                await profileAsync(c, 'comment_create_notify', () => notify(
                    webhookUrl || "",
                    {
                        event: "comment.created",
                        message: `${frontendUrl}/feed/${feedId}\n${user.username} 评论了: ${exist.title}\n${content}`,
                        title: exist.title || "",
                        url: `${frontendUrl}/feed/${feedId}`,
                        username: user.username,
                        content,
                    },
                    {
                        method: webhookMethod,
                        contentType: webhookContentType,
                        headers: webhookHeaders,
                        bodyTemplate: webhookBodyTemplate,
                    },
                ));
            } catch (error) {
                console.error("Failed to send comment webhook", error);
            }
            return c.text('OK');
        }

        // 游客评论
        if (!guestName || !guestName.trim()) {
            return c.text('Guest name is required', 400);
        }

        const approved = (await requiresApproval(serverConfig)) ? 0 : 1;

        await db.insert(comments).values({
            feedId,
            userId: null,
            content,
            guestName: guestName.trim(),
            guestEmail: guestEmail?.trim() || "",
            guestWebsite: safeWebsite(guestWebsite),
            approved,
        });

        const { webhookUrl, webhookMethod, webhookContentType, webhookHeaders, webhookBodyTemplate } =
            await profileAsync(c, 'comment_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
        const frontendUrl = new URL(c.req.url).origin;
        try {
            await profileAsync(c, 'comment_create_notify', () => notify(
                webhookUrl || "",
                {
                    event: "comment.created",
                    message: `${frontendUrl}/feed/${feedId}\n游客 ${guestName} 评论了: ${exist.title}\n${content}`,
                    title: exist.title || "",
                    url: `${frontendUrl}/feed/${feedId}`,
                    username: guestName,
                    content,
                },
                {
                    method: webhookMethod,
                    contentType: webhookContentType,
                    headers: webhookHeaders,
                    bodyTemplate: webhookBodyTemplate,
                },
            ));
        } catch (error) {
            console.error("Failed to send comment webhook", error);
        }
        return c.text('OK');
    });

    // Counterpart to the moderation default above: without this the `approved`
    // column is write-only and a held comment can never be published.
    app.post('/:id/approve', async (c: AppContext) => {
        const db = c.get('db');
        const admin = c.get('admin');

        if (!admin) {
            return c.text('Permission denied', 403);
        }

        const id_num = parseInt(c.req.param('id'));
        const comment = await profileAsync(c, 'comment_approve_lookup', () => db.query.comments.findFirst({ where: eq(comments.id, id_num) }));

        if (!comment) {
            return c.text('Not found', 404);
        }

        await db.update(comments).set({ approved: 1 }).where(eq(comments.id, id_num));
        return c.text('OK');
    });

    app.delete('/:id', async (c: AppContext) => {
        const db = c.get('db');
        const uid = c.get('uid');
        const admin = c.get('admin');
        
        if (uid === undefined) {
            return c.text('Unauthorized', 401);
        }
        
        const id_num = parseInt(c.req.param('id'));
        const comment = await profileAsync(c, 'comment_delete_lookup', () => db.query.comments.findFirst({ where: eq(comments.id, id_num) }));
        
        if (!comment) {
            return c.text('Not found', 404);
        }
        
        // 管理员可删任意评论；普通用户只能删自己的
        if (admin) {
            await db.delete(comments).where(eq(comments.id, id_num));
            return c.text('OK');
        }
        
        if (comment.userId !== uid) {
            return c.text('Permission denied', 403);
        }
        
        await db.delete(comments).where(eq(comments.id, id_num));
        return c.text('OK');
    });

    return app;
}
