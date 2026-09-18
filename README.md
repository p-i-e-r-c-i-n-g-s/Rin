![Cover](./docs/docs/public/rin-logo.png)

English | [简体中文](./README_zh_CN.md)

![GitHub commit activity](https://img.shields.io/github/commit-activity/w/openRin/Rin?style=for-the-badge)
![GitHub branch check runs](https://img.shields.io/github/check-runs/openRin/Rin/main?style=for-the-badge)
![GitHub top language](https://img.shields.io/github/languages/top/openRin/Rin?style=for-the-badge)
![GitHub License](https://img.shields.io/github/license/openRin/Rin?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/openRin/Rin/deploy.yml?style=for-the-badge)

[![Discord](https://img.shields.io/badge/Discord-openRin-red?style=for-the-badge&color=%236e7acc)](https://discord.gg/JWbSTHvAPN)
[![Telegram](https://img.shields.io/badge/Telegram-openRin-red?style=for-the-badge&color=%233390EC)](https://t.me/openRin)

## Introduction

Rin is a modern, serverless blog platform built entirely on Cloudflare's developer platform: Pages for hosting, Workers for serverless functions, D1 for SQLite database, and R2 for object storage. Deploy your personal blog with just a domain name pointed to Cloudflare—no server management required.

## Live Demo

https://xeu.life

## Features

- **Authentication & Management**: GitHub OAuth login. The first registered user becomes an administrator, while subsequent users join as regular members.
- **Content Creation**: Write and edit articles with a rich, intuitive editor.
- **Real-time Autosave**: Local drafts are saved automatically in real-time, with isolation between different articles.
- **Privacy Control**: Mark articles as "Visible only to me" for private drafts or personal notes, synchronized across devices.
- **Image Management**: Drag-and-drop or paste images to upload directly to S3-compatible storage (e.g., Cloudflare R2), with automatic link generation.
- **Custom Slugs**: Assign friendly URLs like `https://yourblog.com/about` using custom article aliases.
- **Unlisted Posts**: Option to keep articles out of the public homepage listing.
- **Blogroll**: Add links to friends' blogs. The backend automatically checks link availability every 20 minutes.
- **Comment System**: Reply to comments or moderate them with delete functionality.
- **Webhook Notifications**: Receive real-time alerts for new comments via configurable webhooks.
- **Featured Images**: Automatically detect the first image in an article and use it as the cover image in listings.
- **Tag Parsing**: Input tags like `#Blog #Cloudflare` and have them automatically parsed and displayed.
- **Type Safety**: End-to-end type safety with shared TypeScript types between client and server via `@rin/api` package.
- ...and more! Explore all features at https://xeu.life.

## Documentation

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/openRin/Rin.git && cd Rin

# 2. Install dependencies
bun install

# 3. Configure environment variables
cp .env.example .env.local
# Edit .env.local with your own configuration

# 4. Start the development server
bun run dev
```

Visit http://localhost:5173 to start hacking!

### Testing

Run the test suite to ensure everything works:

```bash
# Run all tests (client + server)
bun run test

# Run client tests only
bun run test:client

# Run server tests only
bun run test:server

# Run tests with coverage
bun run test:coverage
```

### One-Command Deployment

Deploy both frontend and backend to Cloudflare with a single command:

```bash
# Deploy everything (frontend + backend)
bun run deploy

# Deploy only backend
bun run deploy --server

# Deploy only frontend to Cloudflare Pages
bun run deploy --client
```

> There are no `deploy:server` / `deploy:client` scripts -- the target is a flag
> on the one `deploy` command.

**Required environment variables:**

- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

**Optional environment variables:**

- `WORKER_NAME` - Backend worker name (default: `rin-server`)
- `PAGES_NAME` - Frontend pages name (default: `rin-client`)
- `DB_NAME` - D1 database name (default: `rin`)
- `R2_BUCKET_NAME` - R2 bucket name. If set, deploy derives the matching `S3_*` values automatically. If unset, no bucket is auto-selected.

The deployment script will automatically:

- Create D1 database if it doesn't exist
- Derive `S3_*` storage settings from `R2_BUCKET_NAME` only when it is explicitly set
- Sync worker secrets from the environment
- Deploy backend to Workers, annotating the version with the deployed commit
- Build the frontend and serve it from the Worker's own asset store
- Run database migrations

`bun run deploy` does **not** use Cloudflare Pages: the built client is served
through the Worker's `[assets]` binding. `--client` is the only path that runs
`wrangler pages deploy`.

Because `wrangler deploy` uploads the working tree rather than a commit, the
deploy passes `--message <short-sha>` so the serving version names its own
commit (`-dirty` when the tree was not clean). Read it back with:

```bash
bunx wrangler deployments status
```

Use `status`, not `deployments list`: `list` shows every version, and an
annotated one can sit in it while a later, unannotated one is actually serving.

### GitHub Actions Workflows

The repository includes several automated workflows:

- **`ci.yml`** - Runs type checking and formatting validation on every push/PR
- **`test.yml`** - Runs comprehensive tests (server + client) with coverage reporting
- **`build.yml`** - Builds the project, and on upstream triggers deployment
- **`deploy.yml`** - Deploys to Cloudflare Pages and Workers

> **In this fork, `deploy.yml` is disabled and nothing deploys from CI.** Its
> state is `disabled_manually` in GitHub, which the YAML itself cannot show, and
> the repository holds none of the secrets below. Every release is a hand-run
> `bun run deploy`, so **merging to `main` is not releasing.** Check
> `bunx wrangler deployments status` for what is actually live.

**Required secrets (Repository Settings → Secrets and variables → Actions):**

- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token with Workers and Pages permissions
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

**Optional configuration (Repository Settings → Secrets and variables → Variables):**

- `WORKER_NAME`, `PAGES_NAME`, `DB_NAME` - Resource names
- `NAME`, `DESCRIPTION`, `AVATAR` - Site configuration
- `R2_BUCKET_NAME` - Specific R2 bucket to use

Full documentation is available at https://docs.openrin.org.

## Community & Support

- Join our https://discord.gg/JWbSTHvAPN for discussions and help.
- Follow updates on https://t.me/openRin.
- Found a bug or have a feature request? Please open an issue on GitHub.

## Star History

<a href="https://star-history.dera.page/#openRin/Rin&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=openRin/Rin&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=openRin/Rin&type=Date" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=openRin/Rin&type=Date" />
 </picture>
</a>

## Contributing

We welcome contributions of all kinds—code, documentation, design, and ideas. Please check out our [contributing guidelines](https://docs.openrin.org/en/guide/contribution.html) and join us in building Rin together!

## License

```
MIT License

Copyright (c) 2024 Xeu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
