import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { getStorageObject, putStorageObject } from "../utils/storage";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

export function StorageService(): Hono {
    const app = new Hono();

    // POST /storage
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');

        // Authorise BEFORE touching the body. parseBody() reads the whole
        // multipart upload into memory, so checking uid afterwards meant an
        // anonymous request still got a file buffered on our side before being
        // told 401 -- free work for anyone who wanted to spend it.
        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const key = body.key;
        const file = body.file;

        // key and file were previously asserted rather than checked, so a
        // malformed multipart body reached key.includes(...) and threw an
        // uncaught TypeError outside the try below -- a 500 where 400 is right.
        if (typeof key !== 'string' || !key) {
            return c.text('key is required', 400);
        }
        if (!(file instanceof File)) {
            return c.text('file is required', 400);
        }

        const suffix = key.includes(".") ? key.split('.').pop() : "";
        const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-1' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.${suffix}`;
        
        try {
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(env, hashkey, file, file.type, new URL(c.req.url).origin));
            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    return app;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const key = c.req.path.replace(/^\/blob\/?/, "");

        if (!key) {
            return c.text("Blob key is required", 400);
        }

        let storageKey: string;
        try {
            storageKey = decodeURIComponent(key);
        } catch {
            return c.text("Invalid blob key", 400);
        }

        // This route is public, so it serves uploads and nothing else: keys must
        // sit under S3_FOLDER, with no dot segments that could climb out of it.
        // Without the prefix check it would hand out anything in the bucket,
        // including the feed cache and any object not meant to be linked.
        const folder = (env.S3_FOLDER || "").replace(/^\/+|\/+$/g, "");
        if (
            storageKey.split("/").some((segment) => segment === "." || segment === "..") ||
            (folder && !storageKey.startsWith(`${folder}/`))
        ) {
            return c.text("Not found", 404);
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, storageKey));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
