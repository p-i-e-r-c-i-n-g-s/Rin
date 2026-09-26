import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { PasswordAuthService, loginThrottleKey } from "../auth";
import {
  createMockDB,
  createMockEnv,
  cleanupTestDB,
} from "../../../tests/fixtures";
import { createTestClient } from "../../../tests/test-api-client";
import type { Database } from "bun:sqlite";
import type { Variables } from "../../core/hono-types";

describe("PasswordAuthService", () => {
  let db: any;
  let sqlite: Database;
  let env: Env;
  let app: Hono<{ Bindings: Env; Variables: Variables }>;
  let api: ReturnType<typeof createTestClient>;

  beforeEach(async () => {
    const mockDB = createMockDB();
    db = mockDB.db;
    sqlite = mockDB.sqlite;
    env = createMockEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin123",
    });

    // Setup Hono app with mock db
    app = new Hono<{ Bindings: Env; Variables: Variables }>();

    // Add middleware to inject test dependencies
    app.use(async (c: any, next: any) => {
      c.set("db", db);
      c.set("jwt", {
        sign: async (payload: any) => `mock_token_${payload.id}`,
        verify: async (token: string) => {
          const match = token.match(/mock_token_(\d+)/);
          return match ? { id: parseInt(match[1]) } : null;
        },
      });
      c.set("env", env);
      await next();
    });

    // Register service with prefix
    app.route('/auth', PasswordAuthService());

    // Add error handler
    app.onError((err: any, c: any) => {
      if (err.code && err.statusCode) {
        return c.json(
          {
            success: false,
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          err.statusCode,
        );
      }
      return c.json(
        {
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: err.message || "An unexpected error occurred",
          },
        },
        500,
      );
    });

    api = createTestClient(app, env);
  });

  afterEach(() => {
    cleanupTestDB(sqlite);
  });

  describe("POST /auth/login - Login with credentials", () => {
    it("should login with admin credentials", async () => {
      const result = await api.auth.login({
        username: "admin",
        password: "admin123",
      });

      expect(result.error).toBeUndefined();
      expect(result.data?.success).toBe(true);
      expect(result.data?.token).toBeDefined();
      expect(result.data?.user.username).toBe("admin");
      expect(result.data?.user.permission).toBe(true);
    });

    it("should create admin user on first login", async () => {
      // First login - admin user doesn't exist yet
      const result = await api.auth.login({
        username: "admin",
        password: "admin123",
      });

      expect(result.error).toBeUndefined();
      expect(result.data?.success).toBe(true);
      expect(result.data?.user.id).toBeDefined();

      // Verify admin user was created in database
      const dbResult = sqlite.prepare(`SELECT * FROM users WHERE openid = 'admin'`).all() as any[];
      expect(dbResult.length).toBe(1);
      expect(dbResult[0].username).toBe("admin");
      expect(dbResult[0].permission).toBe(1);
    });

    it("should reject invalid admin password", async () => {
      const result = await api.auth.login({
        username: "admin",
        password: "wrongpassword",
      });

      expect(result.error).toBeDefined();
      expect(result.error?.status).toBe(403);
      const errorData = result.error?.value as any;
      expect(errorData.error.message).toBe("Invalid credentials");
    });

    it("should login with regular user credentials", async () => {
      // Create a regular user with password
      sqlite.exec(`
        INSERT INTO users (id, username, avatar, openid, password, permission) 
        VALUES (2, 'regularuser', 'avatar.png', 'user_2', '${await hashPassword('userpass')}', 0)
      `);

      const result = await api.auth.login({
        username: "regularuser",
        password: "userpass",
      });

      expect(result.error).toBeUndefined();
      expect(result.data?.success).toBe(true);
      expect(result.data?.user.username).toBe("regularuser");
      expect(result.data?.user.permission).toBe(false);
    });

    it("should reject non-existent user", async () => {
      const result = await api.auth.login({
        username: "nonexistent",
        password: "somepassword",
      });

      expect(result.error).toBeDefined();
      expect(result.error?.status).toBe(403);
      const errorData = result.error?.value as any;
      expect(errorData.error.message).toBe("Invalid credentials");
    });

    it("should require username and password", async () => {
      const result = await api.auth.login({
        username: "",
        password: "",
      });

      expect(result.error).toBeDefined();
      expect(result.error?.status).toBe(400);
      const errorData = result.error?.value as any;
      expect(errorData.error.message).toBe("Username and password are required");
    });

    it("should return 400 if admin credentials not configured", async () => {
      const envNoCreds = createMockEnv({
        ADMIN_USERNAME: "",
        ADMIN_PASSWORD: "",
      });

      const honoAppNoCreds = new Hono<{
        Bindings: Env;
        Variables: Variables;
      }>();
      honoAppNoCreds.use(async (c: any, next: any) => {
        c.set("db", db);
        c.set("jwt", {
          sign: async (payload: any) => `mock_token_${payload.id}`,
          verify: async (token: string) => {
            const match = token.match(/mock_token_(\d+)/);
            return match ? { id: parseInt(match[1]) } : null;
          },
        });
        c.set("env", envNoCreds);
        await next();
      });

      honoAppNoCreds.route('/auth', PasswordAuthService());

      // Add error handler
      honoAppNoCreds.onError((err: any, c: any) => {
        if (err.code && err.statusCode) {
          return c.json(
            {
              success: false,
              error: {
                code: err.code,
                message: err.message,
                details: err.details,
              },
            },
            err.statusCode,
          );
        }
        return c.json(
          {
            success: false,
            error: {
              code: "INTERNAL_ERROR",
              message: err.message || "An unexpected error occurred",
            },
          },
          500,
        );
      });

      const appNoCreds = {
        ...honoAppNoCreds,
        fetch: (request: Request, env: Env) =>
          honoAppNoCreds.fetch(request, { ...env, DB: db }),
      };

      const apiNoCreds = createTestClient(appNoCreds, envNoCreds);

      const result = await apiNoCreds.auth.login({
        username: "admin",
        password: "admin123",
      });

      expect(result.error).toBeDefined();
      expect(result.error?.status).toBe(400);
      const errorData = result.error?.value as any;
      expect(errorData.error.message).toBe("Admin credentials not configured");
    });

    it("should reject user without password", async () => {
      // Create a user without password
      sqlite.exec(`
        INSERT INTO users (id, username, avatar, openid, password, permission) 
        VALUES (3, 'nopassworduser', 'avatar.png', 'user_3', NULL, 0)
      `);

      const result = await api.auth.login({
        username: "nopassworduser",
        password: "anypassword",
      });

      expect(result.error).toBeDefined();
      expect(result.error?.status).toBe(403);
      const errorData = result.error?.value as any;
      expect(errorData.error.message).toBe("Invalid credentials");
    });
  });

  describe("POST /auth/login - failed-login throttle", () => {
    const login = (password: string, ip = "203.0.113.7") =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ username: "admin", password }),
      }, env);

    it("returns 429 after five failures, even for the correct password", async () => {
      for (let i = 0; i < 5; i++) {
        expect((await login("wrong")).status).toBe(403);
      }

      expect((await login("wrong")).status).toBe(429);
      // A throttled client learns nothing: the right password gets the same 429.
      expect((await login("admin123")).status).toBe(429);
    });

    it("throttles per client IP", async () => {
      for (let i = 0; i < 5; i++) {
        await login("wrong", "203.0.113.7");
      }

      expect((await login("wrong", "203.0.113.7")).status).toBe(429);
      expect((await login("admin123", "198.51.100.2")).status).toBe(200);
    });

    it("ignores a client-supplied x-real-ip, which would otherwise mint a fresh bucket per request", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await app.request("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9", "x-real-ip": `10.0.0.${i}` },
          body: JSON.stringify({ username: "admin", password: "wrong" }),
        }, env);
        expect(res.status).toBe(403);
      }

      expect((await login("wrong", "203.0.113.9")).status).toBe(429);
    });

    it("clears the count on a successful login", async () => {
      for (let i = 0; i < 4; i++) {
        await login("wrong");
      }
      expect((await login("admin123")).status).toBe(200);

      const rows = sqlite.prepare("SELECT * FROM login_attempts").all();
      expect(rows).toEqual([]);

      for (let i = 0; i < 4; i++) {
        expect((await login("wrong")).status).toBe(403);
      }
    });

    it("evaluates at most five of forty concurrent wrong passwords", async () => {
      // Before the fix all 40 read a count of 0 before any of them recorded a
      // failure, so every one got a password check: 40x 403, none throttled.
      const responses = await Promise.all(Array.from({ length: 40 }, () => login("wrong")));
      const statuses = responses.map((res) => res.status);

      expect(statuses.filter((status) => status === 403).length).toBe(5);
      expect(statuses.filter((status) => status === 429).length).toBe(35);
      expect((await login("admin123")).status).toBe(429);
    });

    it("throttles an IPv6 /64 as one client", async () => {
      // A /64 is the normal allocation to one subscriber, so per-address
      // buckets would hand one attacker 2^64 fresh buckets.
      for (let i = 1; i <= 5; i++) {
        expect((await login("wrong", `2001:db8:1:2::${i}`)).status).toBe(403);
      }

      // Same /64, written uncompressed with leading zeros and upper case.
      expect((await login("wrong", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).status).toBe(429);
      // The neighbouring /64 is a different client.
      expect((await login("admin123", "2001:db8:1:3::1")).status).toBe(200);
    });

    it("starts a fresh window once the old one has expired", async () => {
      for (let i = 0; i < 5; i++) {
        await login("wrong");
      }
      expect((await login("wrong")).status).toBe(429);

      // Age the row past the 15-minute window.
      sqlite.prepare("UPDATE login_attempts SET window_start = window_start - 901").run();

      expect((await login("wrong")).status).toBe(403);
      const rows = sqlite.prepare("SELECT failures FROM login_attempts").all() as any[];
      expect(rows).toEqual([{ failures: 1 }]);
    });
  });

  describe("loginThrottleKey", () => {
    it("keys IPv4 on the full address", () => {
      expect(loginThrottleKey("203.0.113.7")).toBe("203.0.113.7");
      expect(loginThrottleKey("unknown")).toBe("unknown");
    });

    it("keys IPv6 on the /64, whatever the spelling", () => {
      expect(loginThrottleKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
      expect(loginThrottleKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
      expect(loginThrottleKey("2001:db8::")).toBe("2001:db8:0:0::/64");
      expect(loginThrottleKey("::1")).toBe("0:0:0:0::/64");
      expect(loginThrottleKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    });

    it("treats an IPv4-mapped address as the IPv4 address", () => {
      expect(loginThrottleKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    });

    it("leaves anything it cannot parse unchanged", () => {
      expect(loginThrottleKey("1::2::3")).toBe("1::2::3");
      expect(loginThrottleKey("1:2:3")).toBe("1:2:3");
      expect(loginThrottleKey("fe80::1%eth0")).toBe("fe80::1%eth0");
    });
  });

  describe("GET /auth/status - Check auth availability", () => {
    it("should return github and password status", async () => {
      const result = await api.auth.status();

      expect(result.error).toBeUndefined();
      expect(result.data?.github).toBe(true); // Has GitHub credentials in env
      expect(result.data?.password).toBe(true); // Has admin credentials
    });

    it("should return false when credentials not configured", async () => {
      const envNoCreds = createMockEnv({
        RIN_GITHUB_CLIENT_ID: "",
        RIN_GITHUB_CLIENT_SECRET: "",
        ADMIN_USERNAME: "",
        ADMIN_PASSWORD: "",
      });

      const honoAppNoCreds = new Hono<{
        Bindings: Env;
        Variables: Variables;
      }>();
      honoAppNoCreds.use(async (c: any, next: any) => {
        c.set("db", db);
        c.set("env", envNoCreds);
        await next();
      });
      honoAppNoCreds.route('/auth', PasswordAuthService());

      // Add error handler
      honoAppNoCreds.onError((err: any, c: any) => {
        if (err.code && err.statusCode) {
          return c.json(
            {
              success: false,
              error: {
                code: err.code,
                message: err.message,
                details: err.details,
              },
            },
            err.statusCode,
          );
        }
        return c.json(
          {
            success: false,
            error: {
              code: "INTERNAL_ERROR",
              message: err.message || "An unexpected error occurred",
            },
          },
          500,
        );
      });

      // Add fetch method for test client compatibility
      const appNoCreds = {
        ...honoAppNoCreds,
        fetch: (request: Request, env: Env) =>
          honoAppNoCreds.fetch(request, { ...env, DB: db }),
      };

      const apiNoCreds = createTestClient(appNoCreds, envNoCreds);

      const result = await apiNoCreds.auth.status();

      expect(result.error).toBeUndefined();
      expect(result.data?.github).toBe(false);
      expect(result.data?.password).toBe(false);
    });
  });
});

// Hash password using SHA-256
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
