import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { DB } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { feedHashtags, hashtags } from "../db/schema";
import type { AppContext } from "../core/hono-types";

export function TagService(): Hono {
    const app = new Hono();

    // GET /tag
    // Counts only posts the caller may see. Counting every row published the
    // names of tags used only on drafts and unlisted posts, and how many such
    // posts each had, to anyone who asked.
    app.get('/', async (c: AppContext) => {
        const db = c.get('db');
        const admin = c.get('admin');
        
        const tag_list = await profileAsync(c, 'tag_list_db', () => db.query.hashtags.findMany({
            with: {
                feeds: {
                    columns: { feedId: true },
                    with: { feed: { columns: { draft: true, listed: true } } }
                }
            }
        }));
        
        const result = tag_list
            .map((tag: any) => ({
                ...tag,
                feeds: tag.feeds.filter((f: any) => admin || isPublic(f.feed)).length
            }))
            .filter((tag: any) => admin || tag.feeds > 0);
        
        return c.json(result);
    });

    // GET /tag/:name
    app.get('/:name', async (c: AppContext) => {
        const db = c.get('db');
        const admin = c.get('admin');
        // Hono has already percent-decoded the param. A second decodeURI turned
        // a tag with a literal "%" (sent as %25) into a URIError and a 500.
        const nameDecoded = c.req.param('name');
        
        const tag = await profileAsync(c, 'tag_detail_db', () => db.query.hashtags.findFirst({
            where: eq(hashtags.name, nameDecoded),
            with: {
                feeds: {
                    with: {
                        feed: {
                            columns: {
                                id: true, title: true, summary: true, content: true, 
                                createdAt: true, updatedAt: true, draft: false, listed: false
                            },
                            with: {
                                user: { columns: { id: true, username: true, avatar: true } },
                                hashtags: {
                                    columns: {},
                                    with: { hashtag: { columns: { id: true, name: true } } }
                                }
                            },
                            where: (feeds: any) => admin ? undefined : and(eq(feeds.draft, 0), eq(feeds.listed, 1))
                        } as any
                    }
                }
            }
        }));
        
        const tagFeeds = tag?.feeds.map((tagFeed: any) => {
            if (!tagFeed.feed) return null;
            return {
                ...tagFeed.feed,
                hashtags: tagFeed.feed.hashtags.map((hashtag: any) => hashtag.hashtag)
            };
        }).filter((feed: any) => feed !== null);
        
        // A tag on hidden posts only is not acknowledged to exist.
        if (!tag || (!admin && !tagFeeds?.length)) {
            return c.text('Not found', 404);
        }
        
        return c.json({ ...tag, feeds: tagFeeds });
    });

    return app;
}

function isPublic(feed: any) {
    return Boolean(feed) && feed.draft === 0 && feed.listed === 1;
}

export async function bindTagToPost(db: DB, feedId: number, tags: string[]) {
    await db.delete(feedHashtags).where(eq(feedHashtags.feedId, feedId));

    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    if (normalizedTags.length === 0) {
        return;
    }

    const existingTags = await db.select({ id: hashtags.id, name: hashtags.name })
        .from(hashtags)
        .where(inArray(hashtags.name, normalizedTags));
    const tagIds = new Map(existingTags.map((tag) => [tag.name, tag.id]));
    const missingTags = normalizedTags.filter((tag) => !tagIds.has(tag));

    if (missingTags.length > 0) {
        const insertedTags = await db.insert(hashtags)
            .values(missingTags.map((name) => ({ name })))
            .returning({ id: hashtags.id, name: hashtags.name });
        for (const tag of insertedTags) {
            tagIds.set(tag.name, tag.id);
        }
    }

    await db.insert(feedHashtags).values(normalizedTags.map((name) => ({
        feedId,
        hashtagId: tagIds.get(name)!,
    })));
}
