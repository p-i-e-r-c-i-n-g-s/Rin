import { AwsClient } from "aws4fetch";
import { path_join } from "./path";

export function createS3Client(env: Env): AwsClient {
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
    
    return new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
    });
}

export async function putObject(
    client: AwsClient,
    env: Env,
    key: string,
    body: Blob | ArrayBuffer | Uint8Array | string,
    contentType?: string
) {
    const url = buildS3ObjectUrl(env, key);

    const headers: Record<string, string> = {};
    if (contentType) {
        headers["Content-Type"] = contentType;
    }
    
    const response = await client.fetch(url, {
        method: "PUT",
        body: body as BodyInit,
        headers,
    });
    
    if (!response.ok) {
        throw new Error(`Failed to upload to S3: ${response.status} ${response.statusText}`);
    }
    
    return response;
}

// Percent-encodes each path segment of a storage key, so the key can only ever
// be a path. Without this, a key containing `?` or `#` becomes a query string or
// fragment on a SIGNED request: `/api/blob/%3Flist-type%3D2` decoded to
// `?list-type=2` and turned a GET of one object into a signed ListObjectsV2 of
// the whole bucket. aws4fetch decodes the path before signing, so encoded keys
// sign and resolve as the same object.
export function encodeStorageKey(key: string) {
    return key
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

export function buildS3ObjectUrl(env: Env, key: string): string {
    const endpoint = env.S3_ENDPOINT;
    const bucket = env.S3_BUCKET;
    const forcePathStyle = env.S3_FORCE_PATH_STYLE === 'true';
    const encodedKey = encodeStorageKey(key);

    if (forcePathStyle) {
        return path_join(endpoint, bucket, encodedKey);
    }

    const urlObj = new URL(endpoint);
    return `${urlObj.protocol}//${bucket}.${urlObj.host}/${encodedKey}`;
}
