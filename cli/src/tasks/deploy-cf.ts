import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripIndent from "strip-indent";
import {
  fixTopField,
  getMigrationFileVersion,
  getMigrationVersion,
  updateMigrationVersion,
} from "../lib/db-migration";
const bunExec = process.execPath;

function env(name: string, defaultValue?: string, required = false) {
  const value = process.env[name] || defaultValue;
  if (required && !value) {
    throw new Error(`${name} is not defined`);
  }
  return value;
}

const renv = (name: string, defaultValue?: string) => env(name, defaultValue, true)!;

const WORKER_SECRET_KEYS = [
  "JWT_SECRET",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "RIN_GITHUB_CLIENT_ID",
  "RIN_GITHUB_CLIENT_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/**
 * `wrangler deploy` ships the working tree, not a commit. Nothing in Cloudflare
 * has ever recorded WHICH commit is serving, so the only way to answer "is the
 * fix live?" was to read the Worker's `modified_on` timestamp and correlate it
 * against `git log` by hand -- an inference, and a wrong one whenever a deploy
 * carried uncommitted files.
 *
 * `--message` annotates the Worker Version, and that annotation is returned by
 * the deployments API (and `wrangler deployments list`), which turns "which
 * commit is live" into a stored fact read from the same place as the timestamp.
 *
 * The label's one job is to never claim more than it knows:
 *
 *  - a dirty tree deploys files that exist in no commit, so it is labelled
 *    `<sha>-dirty` rather than reported as that sha;
 *  - no git, or a repo with no commits, is `no-git`, not a blank message that
 *    would read as "nobody bothered".
 *
 * This is deliberately NOT a gate. It does not refuse a dirty deploy -- hotfixes
 * from a working tree are how this site is actually operated. It only refuses to
 * describe one as a clean commit.
 */
export function formatDeployMessage({ sha, dirty }: { sha: string | null; dirty: boolean }) {
  if (!sha) {
    return "no-git";
  }
  return dirty ? `${sha}-dirty` : sha;
}

async function resolveDeployMessage() {
  const sha = await $`git rev-parse --short HEAD`.quiet().nothrow();
  const status = await $`git status --porcelain`.quiet().nothrow();

  if (sha.exitCode !== 0 || status.exitCode !== 0) {
    return formatDeployMessage({ sha: null, dirty: false });
  }

  return formatDeployMessage({
    sha: sha.text().trim(),
    dirty: status.text().trim().length > 0,
  });
}

function isQueueAlreadyPresentError(stderr: string) {
  return stderr.includes("already exists") || stderr.includes("already taken") || stderr.includes("[code: 11009]");
}

export function collectWorkerSecrets(source: Record<string, string | undefined> = process.env) {
  const secrets: Record<string, string> = {};

  for (const key of WORKER_SECRET_KEYS) {
    const value = source[key];
    if (value && value.length > 0) {
      secrets[key] = value;
    }
  }

  return secrets;
}

/** Returns false only when the sync could not run, so the caller can retry it. */
async function syncWorkerSecrets(workerName: string) {
  const secrets = collectWorkerSecrets();
  const secretKeys = Object.keys(secrets);

  if (secretKeys.length === 0) {
    console.log("ℹ️ No worker secrets provided; skipping secret sync");
    return true;
  }

  // Outside the checkout, in a directory only this user can read: a deploy
  // killed before the `finally` below used to leave every secret in plaintext
  // in the repo root, one `git add -A` from a public commit.
  const tempDir = await mkdtemp(join(tmpdir(), "rin-secrets-"));
  const tempFile = join(tempDir, "secrets.json");
  await Bun.write(tempFile, JSON.stringify(secrets, null, 2));

  try {
    const { exitCode, stderr } = await $`${bunExec} x wrangler secret bulk ${tempFile} --name ${workerName}`.nothrow();
    if (exitCode !== 0) {
      // Expected on the very first deploy: the Worker does not exist yet, so
      // there is nothing to attach secrets to.
      console.log(`ℹ️ Secret sync could not run yet: ${stderr.toString().trim().split("\n").pop()}`);
      return false;
    }
    console.log(`✅ Synced ${secretKeys.length} worker secret(s)`);
    return true;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ./dist is reused only on CI, where deploy.yml has just restored the artifacts
// build.yml produced for the commit being deployed. Anywhere else ./dist is
// whatever the last `bun run build` left behind, and nothing ties it to HEAD:
// on 23 Sep 2026 a deploy annotated 2fe14b1 shipped a server bundle built on
// 16 Sep, and nothing in the output said so. See CLAUDE.md.
export function shouldReusePrebuilt(environment: Record<string, string | undefined> = process.env) {
  return environment.GITHUB_ACTIONS === "true";
}

export function pickServerMain(reusePrebuilt: boolean, hasServerBuild: boolean) {
  return reusePrebuilt && hasServerBuild ? "dist/server/_worker.js" : "server/src/_worker.ts";
}

async function findD1Database(name: string) {
  const databases = JSON.parse(await $`${bunExec} x wrangler d1 list --json`.quiet().text()) as Array<{ name: string; uuid: string }>;
  return databases.find((item) => item.name === name);
}

async function buildClient() {
  const distIndex = Bun.file("./dist/client/index.html");
  if (shouldReusePrebuilt() && (await distIndex.exists())) {
    console.log("✅ Using pre-built client from ./dist/client");
    return;
  }

  console.log("🔨 Building client...");
  await $`cd client && ${bunExec} run build`.quiet();
  console.log("✅ Client built successfully");
}

type R2BucketInfo = {
  name: string;
  endpoint: string;
  accessHost: string;
};

export function buildR2BucketInfo(r2BucketName: string, accountId: string): R2BucketInfo {
  return {
    name: r2BucketName,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    accessHost: `https://${r2BucketName}.${accountId}.r2.dev`,
  };
}

/**
 * `run_worker_first = ["/"]` is a SECURITY control, not a performance tweak.
 *
 * Without it, Cloudflare's asset store answers any path matching a file in
 * `dist/client` and the Worker never runs, so `withSecurityHeaders` in
 * `server/src/runtime/fetch-handler.ts` never wraps those responses.
 * `index.html` is such a file, so `/` -- the site's most-visited URL -- shipped
 * with no CSP and no X-Frame-Options, i.e. framable, while every other route had
 * both. Measured from a production HAR and reproduced under `wrangler dev` on
 * 18 Sep 2026; the table is in CLAUDE.md.
 *
 * `["/"]` and not `true`: `/` is the only document the asset store can answer.
 * `index.html` is the one HTML file in `dist/client`, `/index.html` answers
 * 307 -> `/`, and `/about`, `/timeline`, `/feed/2` and friends match no file, so
 * they already reach the Worker and are already wrapped. `true` would also route
 * JS, CSS, fonts and locale JSON through the Worker, where these headers do
 * nothing -- CSP and X-Frame-Options are enforced per document, not per
 * subresource -- and `[placement] mode = "smart"` means that detour leaves the
 * local edge.
 *
 * This is an ALLOWLIST: any path not listed goes to the asset store first. It is
 * safe here only because no `not_found_handling` is set, so a path matching no
 * file falls through to the Worker -- which is what keeps `/api/*` working.
 * Verified, not assumed: `/api/feed` and `/api/user/profile` both still returned
 * `application/json` under `["/"]`. In ears-pearcache, which DOES set
 * `not_found_handling`, this same shape served `index.html` in place of every API
 * response. **If `not_found_handling` is ever added to this config, re-verify
 * `/api/*` before shipping it.**
 */
export function buildWranglerAssetsConfig() {
  return stripIndent(`
    [assets]
    directory = "./dist/client"
    binding = "ASSETS"
    run_worker_first = ["/"]
  `);
}

export function buildWranglerTriggersConfig(preview = false) {
  return preview
    ? ""
    : stripIndent(`
        [triggers]
        crons = ["*/20 * * * *"]
      `);
}

export function buildWranglerQueueConfig(taskQueueName: string, preview = false) {
  return stripIndent(`
    [[queues.producers]]
    binding = "TASK_QUEUE"
    queue = "${taskQueueName}"

    [[queues.consumers]]
    queue = "${taskQueueName}"
    max_batch_size = 1
    max_batch_timeout = 5
  `);
}

// Production is served from its own domain, so the workers.dev URL and the
// per-version preview URLs are only a second, unused way in. Leave them on for
// preview deploys (workers.dev is their only address) and when FRONTEND_URL is
// unset or is itself a workers.dev URL, where turning them off takes the site
// down. Top-level keys: must be emitted before any [table] in wrangler.toml.
export function buildWranglerExposureConfig(frontendUrl = "", preview = false) {
  let host = "";
  try {
    host = new URL(frontendUrl).hostname;
  } catch {}
  if (preview || !host || host.endsWith(".workers.dev")) {
    return "";
  }
  return stripIndent(`
    workers_dev = false
    preview_urls = false
  `);
}

export function buildWranglerObservabilityConfig(preview = false) {
  if (!preview) {
    return "";
  }

  return stripIndent(`
    [observability]

    [observability.logs]
    enabled = true
    invocation_logs = true

    [observability.traces]
    enabled = false
  `);
}

async function resolveR2BucketInfo(r2BucketName: string) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return null;
  if (!r2BucketName) {
    return null;
  }
  return buildR2BucketInfo(r2BucketName, accountId);
}

export async function runCloudflareDeploy(target: "all" | "server" | "client" = "all", preview = false) {
  if (target === "client") {
    await buildClient();
    await $`${bunExec} x wrangler pages deploy dist/client`;
    return;
  }

  const dbName = renv("DB_NAME", "rin");
  const workerName = renv("WORKER_NAME", "rin-server");
  const taskQueueName = env("TASK_QUEUE_NAME", env("AI_SUMMARY_QUEUE_NAME", `${workerName}-tasks`)) ?? `${workerName}-tasks`;
  const r2BucketName = env("R2_BUCKET_NAME", "");
  const s3Endpoint = env("S3_ENDPOINT", "");
  const s3AccessHost = env("S3_ACCESS_HOST", "");
  const s3Bucket = env("S3_BUCKET", "");
  const s3CacheFolder = renv("S3_CACHE_FOLDER", "cache/");
  const s3Folder = renv("S3_FOLDER", "images/");
  const s3Region = renv("S3_REGION", "auto");
  const s3ForcePathStyle = env("S3_FORCE_PATH_STYLE", "false");
  const webhookUrl = env("WEBHOOK_URL", "");
  const rssTitle = env("RSS_TITLE", "");
  const rssDescription = env("RSS_DESCRIPTION", "");
  const cacheStorageMode = env("CACHE_STORAGE_MODE", "s3");
  const name = env("NAME", "Rin");
  const description = env("DESCRIPTION", "A lightweight personal blogging system");
  const avatar = env("AVATAR", "");
  const pageSize = env("PAGE_SIZE", "5");
  const rssEnable = env("RSS_ENABLE", "false");
  const frontendUrl = env("FRONTEND_URL", "");

  let finalS3Endpoint = s3Endpoint;
  let finalS3Bucket = s3Bucket;
  let finalS3AccessHost = s3AccessHost;

  if (!finalS3Endpoint || !finalS3Bucket) {
    const r2Info = await resolveR2BucketInfo(r2BucketName || "");
    if (r2Info) {
      finalS3Endpoint ||= r2Info.endpoint;
      finalS3Bucket ||= r2Info.name;
    }
  }

  // Renew wrangler's OAuth token before the first D1 call. The token lasts an
  // hour. Measured 24 Sep 2026: when a D1 command is the one that renews it,
  // D1 often rejects the brand-new token (401 on create, 403 code 7403 on a
  // query, sometimes 401 on list), while a D1 call from the next process
  // works. `whoami` renews through /user, which accepts it at once: 4 of 4
  // forced renewals were followed by clean D1 calls.
  await $`${bunExec} x wrangler whoami`.quiet().nothrow();

  if (target !== "server") {
    await buildClient();
  }

  const hasServerBuild = await Bun.file("./dist/server/_worker.js").exists();
  const serverMain = pickServerMain(shouldReusePrebuilt(), hasServerBuild);
  console.log(`📦 Server entry: ${serverMain}`);
  const exposureConfig = buildWranglerExposureConfig(frontendUrl, preview);
  console.log(`🔒 workers.dev and preview URLs: ${exposureConfig ? "off" : "left on"}`);

  Bun.write(
    "wrangler.toml",
    stripIndent(`
      #:schema node_modules/wrangler/config-schema.json
      name = "${workerName}"
      main = "${serverMain}"
      compatibility_date = "2026-01-20"
      ${exposureConfig}

      ${buildWranglerAssetsConfig()}
      ${buildWranglerTriggersConfig(preview)}
      ${buildWranglerObservabilityConfig(preview)}

      [vars]
      S3_FOLDER = "${s3Folder}"
      S3_CACHE_FOLDER="${s3CacheFolder}"
      S3_REGION = "${s3Region}"
      S3_ENDPOINT = "${finalS3Endpoint}"
      S3_ACCESS_HOST = "${finalS3AccessHost}"
      S3_BUCKET = "${finalS3Bucket}"
      S3_FORCE_PATH_STYLE = "${s3ForcePathStyle}"
      WEBHOOK_URL = "${webhookUrl}"
      RSS_TITLE = "${rssTitle}"
      RSS_DESCRIPTION = "${rssDescription}"
      CACHE_STORAGE_MODE = "${cacheStorageMode}"
      NAME = "${name}"
      DESCRIPTION = "${description}"
      AVATAR = "${avatar}"
      PAGE_SIZE = "${pageSize}"
      RSS_ENABLE = "${rssEnable}"
      FRONTEND_URL = "${frontendUrl}"

      [placement]
      mode = "smart"
    `),
  );

  // List first and create only when missing: an existing database needs no
  // write, which was the call failing above.
  let database = await findD1Database(dbName);
  if (!database) {
    const { exitCode, stderr, stdout } = await $`${bunExec} x wrangler d1 create ${dbName}`.quiet().nothrow();
    if (exitCode !== 0) {
      console.error(`Failed to create D1 "${dbName}"`);
      console.error(stripIndent(stdout.toString()));
      console.error(stripIndent(stderr.toString()));
      process.exit(1);
    }
    database = await findD1Database(dbName);
  }
  // Fail closed. This used to skip the binding and deploy a Worker with no DB.
  if (!database) {
    console.error(`D1 "${dbName}" is not in \`wrangler d1 list\`; refusing to deploy without a DB binding`);
    process.exit(1);
  }

  const queueCreate = await $`${bunExec} x wrangler queues create ${taskQueueName}`.quiet().nothrow();
  if (queueCreate.exitCode !== 0 && !isQueueAlreadyPresentError(queueCreate.stderr.toString())) {
    console.error(`Failed to create Queue "${taskQueueName}"`);
    console.error(stripIndent(queueCreate.stdout.toString()));
    console.error(stripIndent(queueCreate.stderr.toString()));
    process.exit(1);
  }

  await $`echo ${stripIndent(`
    [[d1_databases]]
    binding = "DB"
    database_name = "${database.name}"
    database_id = "${database.uuid}"
  `)} >> wrangler.toml`.quiet();

  await $`echo ${stripIndent(`
    [ai]
    binding = "AI"
  `)} >> wrangler.toml`.quiet();

  await $`echo ${buildWranglerQueueConfig(taskQueueName, preview)} >> wrangler.toml`.quiet();

  if (r2BucketName) {
    await $`echo ${stripIndent(`
      [[r2_buckets]]
      binding = "R2_BUCKET"
      bucket_name = "${r2BucketName}"
      preview_bucket_name = "${r2BucketName}"
    `)} >> wrangler.toml`.quiet();
  }

  const migrationVersion = await getMigrationVersion("remote", dbName);
  // Migration 0011 indexes feeds.top, so repair the column before pending SQL runs.
  await fixTopField("remote", dbName);
  const files = await readdir("./server/sql", { recursive: false });
  const sqlFiles = files
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => {
      const version = getMigrationFileVersion(name);
      return version !== null && version > migrationVersion;
    })
    .sort((left, right) => {
      return (getMigrationFileVersion(left) || 0) - (getMigrationFileVersion(right) || 0);
    });

  for (const file of sqlFiles) {
    await $`${bunExec} x wrangler d1 execute ${dbName} --remote --file ./server/sql/${file} -y`;
    console.log(`Migrated ${file}`);
  }
  if (sqlFiles.length > 0) {
    const lastVersion = getMigrationFileVersion(sqlFiles[sqlFiles.length - 1] || "");
    if (lastVersion !== null) {
      await updateMigrationVersion("remote", dbName, lastVersion);
    }
  }
  const deployMessage = await resolveDeployMessage();

  // Secrets are synced BEFORE the deploy, and the order is the whole point.
  //
  // `wrangler secret bulk` creates a Worker *version* of its own, because secrets
  // are bindings. Running it after `wrangler deploy` therefore stacks an
  // unannotated version on top of the annotated one, and `--message` then names a
  // version that is no longer serving. Observed on the marker's first real use,
  // 18 Sep 2026: the deploy recorded `7886b9e`, and the secret sync seven seconds
  // later superseded it with `Message: -`. A marker naming the wrong version is
  // worse than no marker, because it reads as authoritative.
  //
  // Secrets persist across deploys, so putting them first costs nothing: the
  // final version carries both the code and the secrets, and it is the annotated
  // one. Verify after any change here with `wrangler deployments status` -- the
  // active version's Message must be the sha.
  const secretsSynced = await syncWorkerSecrets(workerName);

  await $`${bunExec} x wrangler deploy --message ${deployMessage}`;

  if (!secretsSynced) {
    // Only reachable on the first deploy of a new Worker, where the pre-deploy
    // sync had nothing to attach to. This leaves an unannotated version on top,
    // which is acceptable exactly once -- nobody asks which commit is live on a
    // Worker that has only ever been deployed once.
    await syncWorkerSecrets(workerName);
  }
}
