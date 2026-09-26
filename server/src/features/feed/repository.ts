import { and, count, desc, eq, or, sql, type Column } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { feeds } from "../../db/schema";

type FeedInsert = typeof feeds.$inferInsert;
type FeedUpdate = Partial<FeedInsert>;

export function findFeedById(db: DB, id: number) {
    return db.query.feeds.findFirst({ where: eq(feeds.id, id) });
}

export function findDuplicateFeed(db: DB, title: string, content: string) {
    return db.query.feeds.findFirst({
        where: or(eq(feeds.title, title), eq(feeds.content, content)),
    });
}

export async function insertFeed(db: DB, values: FeedInsert) {
    const [inserted] = await db.insert(feeds)
        .values(values)
        .returning({ insertedId: feeds.id });
    return inserted ?? null;
}

export function updateFeedById(db: DB, id: number, values: FeedUpdate) {
    return db.update(feeds).set(values).where(eq(feeds.id, id));
}

export function deleteFeedById(db: DB, id: number) {
    return db.delete(feeds).where(eq(feeds.id, id));
}

export type SearchFeedPageOptions = {
    keyword: string;
    admin: boolean;
    pageIndex: number;
    limit: number;
};

function escapeLikePattern(keyword: string): string {
    return keyword.replace(/[%_\\]/g, (char) => `\\${char}`);
}

// SQLite's LIKE has no default escape character, so the backslashes above only
// mean anything with an explicit ESCAPE clause. Without it a search for "100%"
// or "snake_case" looked for a literal backslash and never matched.
function likeLiteral(column: Column, pattern: string) {
    return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

export async function searchFeedPage(db: DB, options: SearchFeedPageOptions) {
    const trimmed = options.keyword ? options.keyword.trim() : "";
    if (!trimmed) {
        return {
            size: 0,
            rows: [],
            hasNext: false,
        };
    }
    const searchPattern = `%${escapeLikePattern(trimmed)}%`;
    const searchWhere = or(
        likeLiteral(feeds.title, searchPattern),
        likeLiteral(feeds.content, searchPattern),
        likeLiteral(feeds.summary, searchPattern),
        likeLiteral(feeds.alias, searchPattern),
    );
    // Anonymous search must match the public feed list: published AND listed.
    // Filtering drafts alone let an unlisted post surface for anyone who
    // searched a word from it.
    const where = options.admin
        ? searchWhere
        : and(searchWhere, eq(feeds.draft, 0), eq(feeds.listed, 1));

    const [sizeRows, rows] = await Promise.all([
        db.select({ count: count() }).from(feeds).where(where),
        db.query.feeds.findMany({
            where,
            columns: options.admin ? undefined : { draft: false, listed: false },
            with: {
                hashtags: {
                    columns: {},
                    with: { hashtag: { columns: { id: true, name: true } } },
                },
                user: { columns: { id: true, username: true, avatar: true } },
            },
            orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
            offset: options.pageIndex * options.limit,
            limit: options.limit + 1,
        }),
    ]);

    const hasNext = rows.length > options.limit;
    if (hasNext) {
        rows.pop();
    }

    return {
        size: sizeRows[0]?.count ?? 0,
        rows,
        hasNext,
    };
}
