import { eq, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, Variables } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { setJWTCookie, clearJWTCookie } from "../core/hono-middleware";
import { loginAttempts, users } from "../db/schema";
import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
    RateLimitError,
} from "../errors";

// Hash password using SHA-256
async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Login throttle. The admin username is published on every post, so before
// this the password was the only barrier and nothing limited guesses.
// ponytail: per-IP (per /64 for IPv6) only, so guessing spread across many IPs
// is slowed, not stopped; add Turnstile on the login form if that ever shows
// up. The zone's one Free-plan rate-limit rule is already spent on "Prevent
// Flooding", which is why this lives in the app.
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 5;

function loginClientIp(c: AppContext) {
    // cf-connecting-ip is set by Cloudflare's edge and cannot be supplied by the
    // client. x-real-ip is deliberately NOT a fallback: a client can set it, and
    // would get a fresh throttle bucket with every request.
    return c.req.header('cf-connecting-ip') || 'unknown';
}

// IPv6 is bucketed by /64. That is the normal allocation to one subscriber, so
// keying on the full address would hand one attacker 2^64 fresh buckets.
// Anything that does not parse as IPv6 (IPv4, 'unknown') is used as is.
export function loginThrottleKey(ip: string) {
    const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mappedV4) {
        return mappedV4[1];
    }
    if (!ip.includes(':')) {
        return ip;
    }

    // An embedded IPv4 tail only fills the last 32 bits, never the /64 prefix.
    const halves = ip.toLowerCase().replace(/\d{1,3}(?:\.\d{1,3}){3}$/, '0:0').split('::');
    const groupsOf = (part: string) => (part ? part.split(':') : []);
    const head = groupsOf(halves[0]);
    const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
    const fill = 8 - head.length - tail.length;
    if (halves.length > 2 || (halves.length === 2 ? fill < 1 : fill !== 0)) {
        return ip;
    }

    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        return ip;
    }
    return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

// Counts this attempt and returns the new count, in one statement. The check
// used to read the count, hash the password, and write the failure afterwards,
// so N concurrent guesses all read the same stale count and all got a password
// check (measured: 40 of 40 evaluated against a limit of 5). A single upsert is
// atomic in D1, so each attempt is judged by the count it wrote itself.
async function reserveLoginAttempt(db: any, key: string, now: number): Promise<number> {
    const expired = now - LOGIN_WINDOW_SECONDS;
    // Housekeeping only: the table holds just the clients with a live window.
    // The CASE below resets an expired row on its own, so correctness does not
    // depend on this delete landing first.
    await db.delete(loginAttempts).where(lte(loginAttempts.windowStart, expired));
    const [row] = await db.insert(loginAttempts)
        .values({ ip: key, failures: 1, windowStart: now })
        .onConflictDoUpdate({
            target: loginAttempts.ip,
            set: {
                failures: sql`CASE WHEN ${loginAttempts.windowStart} <= ${expired} THEN 1 ELSE ${loginAttempts.failures} + 1 END`,
                windowStart: sql`CASE WHEN ${loginAttempts.windowStart} <= ${expired} THEN ${now} ELSE ${loginAttempts.windowStart} END`,
            },
        })
        .returning({ failures: loginAttempts.failures });
    return row.failures;
}

export function PasswordAuthService(): Hono<{
        Bindings: Env;
        Variables: Variables;
    }> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    // Login with username and password
    app.post("/login", async (c: AppContext) => {
        const jwt = c.get('jwt');
        const db = c.get('db');
        const env = c.env;

        // Check if admin credentials are configured
        const adminUsername = env.ADMIN_USERNAME;
        const adminPassword = env.ADMIN_PASSWORD;

        if (!adminUsername || !adminPassword) {
            throw new BadRequestError('Admin credentials not configured');
        }

        const { username, password } = await profileAsync(c, 'auth_login_parse', () => c.req.json()) as { username: string; password: string };

        if (!username || !password) {
            throw new BadRequestError('Username and password are required');
        }

        // Checked before the password is even hashed, so a throttled client gets
        // the same 429 whether or not its guess would have been right. Every
        // attempt is counted up front; a successful login clears the count.
        const ip = loginThrottleKey(loginClientIp(c));
        const now = Math.floor(Date.now() / 1000);
        if (await reserveLoginAttempt(db, ip, now) > LOGIN_MAX_FAILURES) {
            throw new RateLimitError('Too many failed login attempts. Try again later.');
        }
        const rejectLogin = (): never => {
            throw new ForbiddenError('Invalid credentials');
        };

        // Hash the provided password
        const hashedPassword = await profileAsync(c, 'auth_login_hash', () => hashPassword(password));

        // Check if this is the admin login
        if (username === adminUsername) {
            const expectedHash = await profileAsync(c, 'auth_admin_hash', () => hashPassword(adminPassword));
            
            if (hashedPassword !== expectedHash) {
                return rejectLogin();
            }

            // Find or create admin user
            let user = await profileAsync(c, 'auth_admin_lookup', () => db.query.users.findFirst({ 
                where: eq(users.openid, "admin") 
            }));

            if (!user) {
                // Create admin user if not exists
                const result = await profileAsync(c, 'auth_admin_insert', () => db.insert(users).values({
                    username: adminUsername,
                    openid: "admin",
                    avatar: "",
                    permission: 1,
                    password: expectedHash,
                }).returning({ insertedId: users.id }));

                if (!result || result.length === 0) {
                    throw new InternalServerError('Failed to create admin user');
                }

                user = await profileAsync(c, 'auth_admin_reload', () => db.query.users.findFirst({ 
                    where: eq(users.id, result[0].insertedId) 
                }));
            }

            if (!user) {
                throw new InternalServerError('Failed to get admin user');
            }

            if (user.password !== expectedHash) {
                // Update admin password if changed
                await profileAsync(c, 'auth_admin_sync', () => db.update(users)
                    .set({ password: expectedHash, username: adminUsername })
                    .where(eq(users.id, user.id)));
            }

            await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));

            // Generate JWT token
            const token = await profileAsync(c, 'auth_admin_token', () => jwt.sign({ id: user.id }));

            // Set JWT cookie using Hono helper
            setJWTCookie(c, token);

            return c.json({
                success: true,
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar,
                    permission: user.permission === 1,
                }
            });
        }

        // Regular user login (if we want to support multiple users with passwords in the future)
        const user = await profileAsync(c, 'auth_user_lookup', () => db.query.users.findFirst({ 
            where: eq(users.username, username) 
        }));

        if (!user || !user.password || user.password !== hashedPassword) {
            return rejectLogin();
        }

        await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));

        // Generate JWT token
        const token = await profileAsync(c, 'auth_user_token', () => jwt.sign({ id: user.id }));

        // Set JWT cookie using Hono helper
        setJWTCookie(c, token);

        return c.json({
            success: true,
            token: token,
            user: {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                permission: user.permission === 1,
            }
        });
    });

    // Check if password login is available
    app.get("/status", async (c: AppContext) => {
        const env = c.env;
        
        return c.json({
            github: !!(env.RIN_GITHUB_CLIENT_ID && env.RIN_GITHUB_CLIENT_SECRET),
            password: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
        });
    });

    return app;
}
