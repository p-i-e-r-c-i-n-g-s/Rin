import { describe, it, expect } from 'bun:test';
import { SignJWT, decodeJwt } from 'jose';
import { createJWT } from '../jwt';

const SECRET = 'test-jwt-secret';
const key = new TextEncoder().encode(SECRET);

describe('createJWT', () => {
    it('signs tokens that expire seven days after issue', async () => {
        const token = await createJWT(SECRET).sign({ id: 1 });
        const claims = decodeJwt(token);

        expect(typeof claims.exp).toBe('number');
        expect(typeof claims.iat).toBe('number');
        expect(claims.exp! - claims.iat!).toBe(7 * 24 * 60 * 60);
    });

    it('verifies a freshly signed token', async () => {
        const jwt = createJWT(SECRET);
        const payload = await jwt.verify(await jwt.sign({ id: 42 }));

        expect(payload).not.toBe(false);
        expect(payload.id).toBe(42);
    });

    it('rejects a token with no exp claim, as every token issued before expiry existed has', async () => {
        const legacy = await new SignJWT({ id: 1 })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .sign(key);

        expect(await createJWT(SECRET).verify(legacy)).toBe(false);
    });

    it('rejects an expired token', async () => {
        const now = Math.floor(Date.now() / 1000);
        const expired = await new SignJWT({ id: 1 })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(now - 3600)
            .setExpirationTime(now - 60)
            .sign(key);

        expect(await createJWT(SECRET).verify(expired)).toBe(false);
    });

    it('rejects a token signed with a different secret', async () => {
        const other = await createJWT('some-other-secret').sign({ id: 1 });

        expect(await createJWT(SECRET).verify(other)).toBe(false);
    });
});
