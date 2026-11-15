# Deploying the web app to Vercel

Scope: the Next.js app in `apps/web` (this repo's `vercel.json`). Local/test-verified only; no live
Vercel deployment, provider, or checkout has been exercised from this repository.

## What deploys
- `vercel.json` installs with `npm ci` at the repo root (workspaces) and runs `npm run web:build`
  (its `prebuild` builds `@trendie/inspection` and `@trendie/agent`). Output is `apps/web/.next`.
- Leave the Vercel Root Directory at the repo root. Node 22+ (`engines`).

## The gateway is NOT deployed by this config
`gateway/` is a long-running Fastify server with PostgreSQL, in-memory rate limits and migrations.
Host it separately (any Node host with Postgres) over HTTPS, apply its migrations yourself, and point
the web app at it. Never run a migration against production without owner authorization.

## Environment variables (Project Settings, server-side only)
| Name | Required | Notes |
| --- | --- | --- |
| `GATEWAY_BASE_URL` | yes | HTTPS URL of the gateway. HTTP is accepted only for loopback; on Vercel it must be set. |
| `API_KEY_DASHBOARD`, `API_KEY_AGENT` | yes | Distinct; must match the gateway. |
| `API_KEY_ADMIN` | for audit verify | No development fallback in production/Vercel. |
| `DEMO_OWNER_ID` | yes | Owner id for demo intents. |
| `QATOM_MCP_TOKEN` | no | Read-only Qatom probe only (CLI); endpoint fixed in code. |
| `BACKBOARD_API_KEY` | no | Key only. `createBackboardModel` calls `https://app.backboard.io/api/threads/messages`. Optional `BACKBOARD_LLM_PROVIDER`, `BACKBOARD_MODEL_NAME`. |

## Known limits
- **PDF upload** (`/api/pdf`) spawns Python (`services/pdf-inspection`). Vercel's Node runtime has no
  Python/pdfplumber, so it returns the 422 "extraction failed" error there. Text-based verification works.
- **Backboard**: wired by key only via the REST adapter (request shape taken from its quickstart, unit-tested with a mocked fetch; never called with a real key). The web app currently rejects live model calls (`useLiveModel`), so the deployed app does not use it yet.
- **Qatom**: only the read-only client/CLI exists; the web app does not call Qatom.
