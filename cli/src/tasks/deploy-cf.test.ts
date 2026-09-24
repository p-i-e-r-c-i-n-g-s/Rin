import { describe, expect, it } from "bun:test";
import {
  buildWranglerAssetsConfig,
  buildWranglerObservabilityConfig,
  formatDeployMessage,
  buildWranglerQueueConfig,
  buildWranglerTriggersConfig,
  collectWorkerSecrets,
  pickServerMain,
  shouldReusePrebuilt,
} from "./deploy-cf";

describe("collectWorkerSecrets", () => {
  it("includes supported non-empty worker secrets", () => {
    const secrets = collectWorkerSecrets({
      JWT_SECRET: "jwt-secret",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password",
      RIN_GITHUB_CLIENT_ID: "client-id",
      RIN_GITHUB_CLIENT_SECRET: "client-secret",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
      UNUSED: "ignored",
    });

    expect(secrets).toEqual({
      JWT_SECRET: "jwt-secret",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password",
      RIN_GITHUB_CLIENT_ID: "client-id",
      RIN_GITHUB_CLIENT_SECRET: "client-secret",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    });
  });

  it("omits empty secret values", () => {
    const secrets = collectWorkerSecrets({
      JWT_SECRET: "",
      ADMIN_USERNAME: undefined,
      ADMIN_PASSWORD: "password",
    });

    expect(secrets).toEqual({
      ADMIN_PASSWORD: "password",
    });
  });
});

describe("buildWranglerTriggersConfig", () => {
  it("omits cron triggers for preview deploys", () => {
    expect(buildWranglerTriggersConfig(true)).toBe("");
  });

  it("includes cron triggers for production deploys", () => {
    expect(buildWranglerTriggersConfig(false)).toContain("[triggers]");
    expect(buildWranglerTriggersConfig(false)).toContain('crons = ["*/20 * * * *"]');
  });
});

describe("buildWranglerQueueConfig", () => {
  it("includes queue consumers for preview deploys", () => {
    const config = buildWranglerQueueConfig("rin-preview-tasks", true);
    expect(config).toContain('queue = "rin-preview-tasks"');
    expect(config).toContain("[[queues.consumers]]");
  });

  it("includes queue consumers for production deploys", () => {
    const config = buildWranglerQueueConfig("rin-tasks", false);
    expect(config).toContain("[[queues.producers]]");
    expect(config).toContain("[[queues.consumers]]");
  });
});

describe("buildWranglerObservabilityConfig", () => {
  it("enables invocation logs and disables traces for preview deploys", () => {
    const config = buildWranglerObservabilityConfig(true);
    expect(config).toContain("[observability]");
    expect(config).toContain("[observability.logs]");
    expect(config).toContain("enabled = true");
    expect(config).toContain("invocation_logs = true");
    expect(config).toContain("[observability.traces]");
    expect(config).toContain("enabled = false");
  });

  it("omits observability overrides for production deploys", () => {
    expect(buildWranglerObservabilityConfig(false)).toBe("");
  });
});

describe("formatDeployMessage", () => {
  // The marker exists because `wrangler deploy` ships the working tree, not a
  // commit. Its only real requirement is that it cannot report a dirty deploy as
  // a clean commit -- that is the inference this replaces, and the one that was
  // wrong before.
  it("reports a clean tree as the bare sha", () => {
    expect(formatDeployMessage({ sha: "abc1234", dirty: false })).toBe("abc1234");
  });

  it("never reports a dirty tree as that sha", () => {
    const dirty = formatDeployMessage({ sha: "abc1234", dirty: true });

    expect(dirty).not.toBe("abc1234");
    expect(dirty).toBe("abc1234-dirty");
  });

  it("says so when there is no git at all, rather than going blank", () => {
    // An empty message renders as "no message" in `wrangler deployments list`,
    // which is indistinguishable from a deploy that predates this marker.
    const message = formatDeployMessage({ sha: null, dirty: false });

    expect(message).toBe("no-git");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("buildWranglerAssetsConfig", () => {
  it("declares the asset store binding and directory", () => {
    const config = buildWranglerAssetsConfig();

    expect(config).toContain("[assets]");
    expect(config).toContain('directory = "./dist/client"');
    expect(config).toContain('binding = "ASSETS"');
  });

  it("keeps run_worker_first, without which the front page loses every security header", () => {
    // The asset store answers `/` from index.html and never invokes the Worker,
    // so withSecurityHeaders does not run and `/` ships with no CSP and no
    // X-Frame-Options. Nothing reports that -- the page renders fine. If this
    // line is ever dropped from the generated config, this is the only thing
    // that will notice.
    expect(buildWranglerAssetsConfig()).toContain('run_worker_first = ["/"]');
  });

  it("scopes run_worker_first to an allowlist rather than every asset request", () => {
    // `true` also works, but routes JS/CSS/fonts/locale JSON through the Worker
    // -- where these headers do nothing, being per-document -- and past the
    // smart-placement colo. Widening it should be a deliberate edit here, not a
    // silent latency regression.
    expect(buildWranglerAssetsConfig()).not.toContain("run_worker_first = true");
  });
});

describe("pickServerMain", () => {
  it("bundles from source on a local deploy even when a stale dist/server exists", () => {
    // The 23 Sep 2026 failure: a 16 Sep bundle shipped under the label 2fe14b1.
    expect(pickServerMain(shouldReusePrebuilt({}), true)).toBe("server/src/_worker.ts");
  });

  it("reuses the CI build artifact only on GitHub Actions", () => {
    expect(pickServerMain(shouldReusePrebuilt({ GITHUB_ACTIONS: "true" }), true)).toBe("dist/server/_worker.js");
    expect(pickServerMain(shouldReusePrebuilt({ GITHUB_ACTIONS: "true" }), false)).toBe("server/src/_worker.ts");
    expect(shouldReusePrebuilt({ GITHUB_ACTIONS: "false" })).toBe(false);
  });
});
