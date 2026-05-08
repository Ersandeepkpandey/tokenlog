# TokenLog — Development Guide

> Complete technical reference for contributors. Everything you need to understand, build, and extend this project.

---

## What This Is

A VS Code extension that tracks AI token usage and cost in real-time across Claude Code and other AI APIs. Users install the extension and immediately see token counts and cost in their status bar — no sign-in required. The dashboard is fully local, running inside VS Code with no server dependency.

The project also includes a backend API and website (currently kept but not required for core extension functionality).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  VS CODE EXTENSION  (apps/extension)                        │
│                                                             │
│  chokidar → fs.watch(~/.claude/**/*.jsonl)                  │
│  tokenTracker.ts → parses JSONL, computes cost locally      │
│  statusBar       → live token + cost display                │
│  webviewPanel    → 4-tab dashboard (postMessage updates)    │
└──────────────────────────┬──────────────────────────────────┘
                           │ (optional sync, not required)
┌──────────────────────────▼──────────────────────────────────┐
│  BACKEND API  (apps/api) — Node.js + Fastify on Railway     │
│  /auth/*  /usage/*  /billing/*  /team/*                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  DATABASE  (PostgreSQL on Neon.tech)                        │
│  users · usage_sessions · daily_stats · budgets · teams     │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  WEBSITE  (apps/web) — Next.js 14 on Vercel                 │
│  /  /pricing  /auth/vscode  /dashboard                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

### VS Code Extension (`apps/extension`)
| Concern | Choice |
|---|---|
| Language | TypeScript 5 |
| Bundler | esbuild (100× faster than webpack, tiny output) |
| File watching | chokidar (cross-platform, reliable JSONL tailing) |
| Storage | VS Code SecretStorage (OS keychain — never globalState for tokens) |
| Dashboard | Webview panel with postMessage live updates |

### Backend (`apps/api`)
| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Fastify 4 (2× faster than Express, built-in schema validation) |
| Database | PostgreSQL via Neon.tech (serverless, generous free tier) |
| ORM | Prisma 5 (type-safe, great migrations) |
| Auth | Clerk.com (signup/login/social/MFA) |
| Payments | Stripe |
| Hosting | Railway.app |
| Email | Resend.com |

### Website (`apps/web`)
| Concern | Choice |
|---|---|
| Framework | Next.js 14 (App Router) |
| UI | shadcn/ui + Tailwind CSS |
| Charts | Recharts |
| Auth | Clerk (Next.js SDK) |
| Deploy | Vercel |

---

## Monorepo Structure

```
tokenlog/
├── apps/
│   ├── api/                  ← Fastify backend
│   │   ├── src/
│   │   │   ├── routes/       ← auth, usage, billing, user, team, webhooks
│   │   │   ├── middleware/   ← authenticate.ts, requirePlan()
│   │   │   ├── services/     ← statsService.ts
│   │   │   └── lib/          ← prisma.ts, jwt.ts, pricing.ts, email.ts
│   │   └── prisma/
│   │       └── schema.prisma
│   │
│   ├── web/                  ← Next.js website
│   │   └── src/
│   │       ├── app/          ← pages (layout, dashboard, pricing, auth/vscode)
│   │       ├── components/   ← charts, dashboard, landing
│   │       └── lib/          ← api.ts, utils.ts
│   │
│   └── extension/            ← VS Code extension
│       ├── src/
│       │   ├── extension.ts  ← entry point, commands, webview dashboard
│       │   ├── tokenTracker.ts ← JSONL file watcher + parser
│       │   ├── pricing.ts    ← cost calculation (local, no API)
│       │   └── types.ts      ← shared TypeScript interfaces
│       ├── esbuild.js
│       ├── package.json
│       └── tsconfig.json
│
├── DEVELOPMENT.md            ← this file
├── LICENSE                   ← MIT
├── CONTRIBUTING.md
└── CODE_OF_CONDUCT.md
```

---

## Local Development Setup

```bash
# Prerequisites: Node 20+, pnpm, Docker (for local Postgres)

# 1. Clone and install
git clone https://github.com/Ersandeepkpandey/tokenlog.git
cd tokenlog
pnpm install

# 2. Start local Postgres (only needed for API/web development)
docker run -d --name tokenlog-db \
  -e POSTGRES_DB=tokenlog \
  -e POSTGRES_USER=dev \
  -e POSTGRES_PASSWORD=dev \
  -p 5432:5432 postgres:16

# 3. Copy env files and fill in values
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 4. Run DB migrations
cd apps/api && pnpm prisma migrate dev

# 5. Start all services
cd ../.. && pnpm dev   # starts api (port 3001) + web (port 3000)

# 6. Run extension in VS Code
cd apps/extension
code .   # then press F5 to launch Extension Development Host
```

---

## Extension — How It Works

The extension is **fully local** — no server required for the core tracking experience.

### Token tracking flow

1. `chokidar` watches `~/.claude/**/*.jsonl` (Claude Code session files)
2. On file change, `tokenTracker.ts` reads only the new bytes (incremental, via byte offset)
3. Each JSONL line is parsed for `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`
4. Cost is calculated locally using the embedded pricing table in `pricing.ts`
5. A debounced `update` event fires, updating the status bar and dashboard via `postMessage`

### Key files

**[apps/extension/src/tokenTracker.ts](apps/extension/src/tokenTracker.ts)** — core tracker
- Uses chokidar for reliable cross-platform watching
- `readFrom(filePath, offset)` reads only new bytes (critical for performance)
- `parseLine()` extracts token counts and accumulates into `SessionStats`
- `extractProjectName()` decodes Claude's encoded project directory names

**[apps/extension/src/pricing.ts](apps/extension/src/pricing.ts)** — cost calculation
- Embedded pricing table (per 1M tokens) for all supported models
- `calcCost(model, tokens)` — pure function, no API calls

**[apps/extension/src/extension.ts](apps/extension/src/extension.ts)** — VS Code entry point
- Registers all commands and the status bar item
- `showDashboardPanel()` creates/reveals the webview
- `onStatsUpdate()` uses `postMessage` to update the live dashboard without re-rendering HTML

**[apps/extension/src/types.ts](apps/extension/src/types.ts)** — shared interfaces
- `SessionStats`, `AllStats`, `UserSession`, `PLAN_FEATURES`

### Dashboard (webview)

The dashboard is a 4-tab HTML page embedded in a VS Code webview panel:
- **Overview** — total tokens, cost, all-time stats
- **Sessions** — per-session breakdown with model, project, cost
- **Models** — cost comparison across models using the local pricing table
- **Projects** — cost grouped by workspace project

Live updates use `postMessage` from the extension → webview JS handles `window.addEventListener('message', ...)` and does targeted DOM updates with CSS flash animations — no full HTML re-render.

### Adding a new model

1. Add pricing to `apps/extension/src/pricing.ts`:
   ```typescript
   'new-model-name': { input: X.XX, output: X.XX, cacheRead: X.XX, cacheWrite: X.XX },
   ```
2. Add to the `enum` in `apps/extension/package.json` under `aiTokenTracker.model`
3. Add to `apps/api/src/lib/pricing.ts` if you also want backend cost tracking

---

## Backend API

### Environment variables

```env
# apps/api/.env
DATABASE_URL="postgresql://user:pass@host/dbname?sslmode=require"
CLERK_SECRET_KEY="sk_live_..."
CLERK_WEBHOOK_SECRET="whsec_..."
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_PRO_MONTHLY="price_..."
STRIPE_PRICE_TEAM_MONTHLY="price_..."
API_BASE_URL="https://api.aitokentracker.com"
APP_BASE_URL="https://aitokentracker.com"
JWT_SECRET="generate-with-openssl-rand-base64-32"
PORT=3001
```

### Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Health check |
| POST | `/auth/exchange` | none | Exchange short-lived code for JWT |
| POST | `/auth/refresh` | none | Refresh JWT using refresh token |
| GET | `/auth/vscode-callback` | Clerk | Generate exchange code, redirect to extension |
| POST | `/usage/sync` | JWT | Upsert session data (idempotent) |
| GET | `/usage/summary` | JWT | Totals for dashboard |
| GET | `/usage/daily` | JWT | Per-day stats for charts |
| GET | `/usage/sessions` | JWT | Paginated session list |
| GET | `/usage/projects` | JWT | Cost grouped by project |
| GET | `/usage/export` | JWT + Pro | CSV export |
| GET | `/billing/plans` | none | Plan list |
| POST | `/billing/checkout` | JWT | Create Stripe checkout session |
| POST | `/billing/portal` | JWT | Create Stripe billing portal session |
| POST | `/webhooks/stripe` | Stripe sig | Handle subscription events |
| POST | `/webhooks/clerk` | Svix sig | Sync user creation/deletion |

### Auth middleware

`authenticate` — verifies JWT, attaches `req.userId` and `req.userPlan`

`requirePlan(minPlan)` — returns a preHandler that rejects requests below the required plan. Currently set to a no-op (all features are free):
```typescript
export function requirePlan(_minPlan: Plan) {
  return async (_req: FastifyRequest, _reply: FastifyReply) => {};
}
```

### Deployment (Railway)

```bash
railway init && railway add postgresql
railway variables set DATABASE_URL="..." CLERK_SECRET_KEY="..." # etc.
railway up
railway run pnpx prisma migrate deploy
```

`railway.toml`:
```toml
[build]
builder = "NIXPACKS"
buildCommand = "pnpm build && pnpx prisma generate"

[deploy]
startCommand = "pnpx prisma migrate deploy && node dist/index.js"
healthcheckPath = "/health"
```

---

## Database Schema

Full Prisma schema at [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma).

### Core tables

**`users`** — Clerk ID, email, plan, Stripe IDs, settings JSON
**`usage_sessions`** — one row per Claude Code session: token counts, cost, model, project
**`daily_stats`** — pre-aggregated per user/date/project/model for fast chart queries
**`monthly_stats`** — further aggregated for billing period summaries
**`budgets`** — daily/monthly spend limits per user
**`teams`** / **`team_members`** / **`team_invites`** — team plan structure
**`api_keys`** — hashed API keys for programmatic access
**`audit_log`** — immutable action log (required for Enterprise)

### Migration commands

```bash
pnpx prisma migrate dev --name <description>   # dev: creates + applies
pnpx prisma migrate deploy                      # production: applies pending
pnpx prisma migrate reset                       # dev only: destroys all data
pnpx prisma generate                            # regenerate client after schema change
pnpx prisma studio                              # visual DB browser
```

### Key patterns

**Always upsert sessions** — the extension re-sends the same `sessionId` on every sync:
```typescript
await prisma.usageSession.upsert({ where: { id: sessionId }, update: {...}, create: {...} });
```

**Roll up to daily stats** after every session upsert — recalculate from source rather than incrementing:
```typescript
async function recalcDailyStats(userId: string, date: string) { ... }
```

---

## Website (apps/web)

Next.js 14 with Clerk auth and Stripe billing.

### Environment variables

```env
# apps/web/.env.local
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_live_..."
CLERK_SECRET_KEY="sk_live_..."
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL="/dashboard"
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL="/onboarding"
NEXT_PUBLIC_API_URL="https://api.aitokentracker.com"
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_live_..."
```

### Key pages

- `/` — landing page
- `/pricing` — plan picker with Stripe checkout links
- `/auth/vscode` — OAuth callback entry point opened by the extension
- `/dashboard` — usage charts + session history (Pro)
- `/onboarding` — shown after first signup

### VS Code auth flow

1. Extension opens browser to `/auth/vscode?state=<random>&callback=http://127.0.0.1:<port>/callback`
2. User signs in/up via Clerk
3. Page calls backend `GET /auth/vscode-callback?userId=...&state=...&callbackUrl=...`
4. Backend generates a 60-second exchange code, redirects to `callbackUrl?token=<code>&state=<state>`
5. Extension's local HTTP server receives the code
6. Extension calls `POST /auth/exchange` with the code → receives JWT + refresh token
7. JWT stored in VS Code SecretStorage (OS keychain)

### Deployment (Vercel)

```bash
cd apps/web && vercel
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
# set all other env vars in Vercel dashboard
```

---

## Extension — Build & Publish

```bash
cd apps/extension

# Development (watch mode with source maps)
pnpm watch

# One-time build
pnpm compile

# Package as .vsix
pnpm package
# → tokenlog-X.X.X.vsix

# Install locally to test
code --install-extension tokenlog-X.X.X.vsix

# Publish to VS Code Marketplace
# Requires PAT from dev.azure.com with Marketplace (publish) scope
npx @vscode/vsce publish --no-yarn
# or auto-increment version:
npx @vscode/vsce publish patch --no-yarn
```

### .vscodeignore

Keeps the `.vsix` small — excludes source, node_modules, dev files. Only `dist/` and assets are included.

### esbuild config (`esbuild.js`)

- Bundles everything including chokidar into a single `dist/extension.js`
- `vscode` is marked `external` (provided by VS Code runtime)
- Production build is minified; dev build has source maps
- `API_BASE` and `APP_BASE` injected at build time via `define`

---

## Pricing Table

All pricing is per 1M tokens (USD):

| Model | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| claude-opus-4 | $15.00 | $75.00 | $1.50 | $18.75 |
| claude-sonnet-4 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-haiku-3-5 | $0.80 | $4.00 | $0.08 | $1.00 |
| gpt-4o | $2.50 | $10.00 | $1.25 | $0 |
| gpt-4o-mini | $0.15 | $0.60 | $0.075 | $0 |

Defined in both `apps/extension/src/pricing.ts` and `apps/api/src/lib/pricing.ts` — keep them in sync when updating.

---

## Phase 2 Features (Planned)

Phase 1 answers: *"how many tokens did I use?"*
Phase 2 answers: *"what did it cost, why, and how can I reduce it?"*

### Pre-send input cost warning
Before sending a prompt, count tokens (Anthropic's `countTokens` API), show the input cost. Only shown when input is notably large (4× the user's average or over $0.05). Displays *why* the prompt is expensive (large file, long conversation, large system prompt).

### Live streaming ticker
Status bar updates in real time as the AI response streams in, ticking up token by token. Uses approximate character-count estimate during streaming; settles on exact token counts from the final message event.

### Model comparison
After each session, calculate what the same token counts would cost on alternative models. Pure arithmetic from the pricing table — no AI involved. Shown as a passive card in the dashboard.

### Budget alerts
Daily and monthly spend limits with email + VS Code notification alerts at configurable thresholds (default 80%). Optional hard enforcement (blocks sends when limit is reached) as an opt-in setting.

### Weekly email digest
Sent every Monday. One specific insight per email (e.g. "your system prompt is 1,200 tokens per turn — enabling caching could save $2/week"). Rule-based, not AI-generated. Via Resend.

### Phase 2 delivery schedule
```
Week 4   SDK wrapper npm package + IPC with extension
Week 5   Pre-send token count notification
Week 6   Live streaming ticker
Week 7   Dashboard Pro/free locked states
Week 8   Model comparison card
Week 9   Budget alerts + hard enforcement
Week 10  Weekly digest email
Week 11  Projects + Models tabs
Week 12  CSV export + settings page
```

---

## Deployment Checklist (First Deploy)

- [ ] Create Neon.tech project → copy `DATABASE_URL`
- [ ] Create Clerk application → configure OAuth, copy keys, set up webhook to `/webhooks/clerk`
- [ ] Create Stripe account → create Pro/Team products, configure webhook to `/webhooks/stripe`
- [ ] Deploy API to Railway → set all env vars → run `prisma migrate deploy`
- [ ] Deploy website to Vercel → set all env vars
- [ ] Test full auth flow end-to-end
- [ ] Build extension with production `API_BASE`/`APP_BASE` → publish to Marketplace

### CI/CD (ongoing)
- [ ] GitHub Actions: test → build → deploy on merge to main
- [ ] Sentry for error tracking (free tier)
- [ ] Axiom or Logtail for log aggregation

---

## Success Metrics (Phase 2 targets)

| Metric | Target |
|---|---|
| Free → Pro conversion | > 8% |
| Weekly digest open rate | > 40% |
| Pre-send warnings per day (per Pro user) | 2–5 |
