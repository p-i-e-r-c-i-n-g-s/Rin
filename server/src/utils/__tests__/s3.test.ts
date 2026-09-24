import { describe, it, expect } from 'bun:test';
import { buildS3ObjectUrl, encodeStorageKey } from '../s3';
import { createMockEnv } from '../../../tests/fixtures';

describe('buildS3ObjectUrl', () => {
    const env = createMockEnv();

    it('builds a virtual-hosted URL for an ordinary key, unchanged', () => {
        expect(buildS3ObjectUrl(env, 'images/abc.png'))
            .toBe('https://test-bucket.test.r2.cloudflarestorage.com/images/abc.png');
    });

    // The pre-public audit's finding: a key of "?list-type=2" used to become a
    // query string on a signed request, which is ListObjectsV2 on the bucket.
    it('keeps ? and # inside the path instead of turning them into a query or fragment', () => {
        const url = new URL(buildS3ObjectUrl(env, '?list-type=2'));

        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(url.pathname).toBe('/%3Flist-type%3D2');

        const withHash = new URL(buildS3ObjectUrl(env, 'images/a#b'));
        expect(withHash.hash).toBe('');
        expect(withHash.pathname).toBe('/images/a%23b');
    });

    it('encodes keys in path-style URLs too', () => {
        const pathStyle = createMockEnv({ S3_FORCE_PATH_STYLE: 'true' });
        const url = new URL(buildS3ObjectUrl(pathStyle, 'images/?x=1'));

        expect(url.search).toBe('');
        expect(url.pathname).toBe('/test-bucket/images/%3Fx%3D1');
    });

    it('encodeStorageKey preserves separators and drops empty segments', () => {
        expect(encodeStorageKey('/images//a b+c.png')).toBe('images/a%20b%2Bc.png');
    });
});
