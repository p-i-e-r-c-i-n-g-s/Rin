import {
    SignJWT,
    jwtVerify,
    type JWTPayload,
    type JWSHeaderParameters,
    type KeyLike
} from 'jose'

export interface JWTPayloadSpec {
    iss?: string
    sub?: string
    aud?: string | string[]
    jti?: string
    nbf?: number
    exp?: number
    iat?: number
}

export interface JWTUtils {
    sign: (payload: any) => Promise<string>;
    verify: (jwt?: string) => Promise<any | false>;
}

export const TOKEN_LIFETIME = '7d';

export function createJWT(secret: string | Uint8Array | KeyLike): JWTUtils {
    if (!secret) throw new Error("Secret can't be empty");

    const key = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
    const alg = 'HS256';

    return {
        sign: async (payload: any) => {
            // Tokens used to carry no `exp` and were accepted forever: logout only
            // cleared the browser's copy, so any token ever issued stayed an admin
            // credential until JWT_SECRET changed. 7d matches the cookie lifetime
            // in setJWTCookie (core/hono-middleware.ts); change both together.
            const jwt = new SignJWT(payload)
                .setProtectedHeader({ alg })
                .setIssuedAt()
                .setExpirationTime(TOKEN_LIFETIME);
            
            return jwt.sign(key);
        },
        verify: async (jwt?: string): Promise<any | false> => {
            if (!jwt) return false;

            try {
                // requiredClaims rejects tokens minted before expiry existed, so
                // they stop working at deploy rather than living on.
                const data = (await jwtVerify(jwt, key, { requiredClaims: ['exp'] })).payload;
                return data;
            } catch (_) {
                return false;
            }
        }
    };
}

export default createJWT;
