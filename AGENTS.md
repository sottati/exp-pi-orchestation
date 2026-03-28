---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Project Context (pi-agent-core MPV)

This repository is a terminal-first multi-agent runtime prototype.

- CLI entry point: `apps/cli/index.ts`
- Web backend entry point: `apps/backend/server.ts`
- Agent activity endpoint: `/api/agents/:id/activity` (traces/chats/jobs filtered by agent)
- UI gate entry point: `apps/backend/ui-gate.ts`
- Web UI shell: `apps/web/index.html`
- Web UI app: `apps/web/app.tsx` (sidebar navigation, home + per-agent views, direct messaging, thread sync)
- Web UI shared types: `apps/web/types.ts`
- Web UI sidebar: `apps/web/sidebar.tsx` (Dithie icon + per-agent spider avatars)
- Web UI specialist spider avatars: `apps/web/sidebar-spider.tsx` (16x16 pixel-art sprites)
- Web UI agent view: `apps/web/agent-view.tsx` (activity + chat tabs with inter-agent messages)
- Web UI styles: `apps/web/app.css`
- Web UI Dithie sprite: `apps/web/dithie-sprite.tsx` (idle/thinking/walking/error; walks when replying to user, thinks while coordinating specialists)
- Runtime: `packages/core/runtime.ts`
- Tools: `packages/core/tools.ts`
- Agents: `packages/core/agents.ts` (agent definitions via builder pattern)
- Agent builder: `packages/core/agent-builder.ts` (`defineAgent().name().model().tools().build()`)
- Tool registry: `packages/core/tool-registry.ts` (register/resolve tools with glob patterns, MCP lifecycle)
- Tool middleware: `packages/core/tool-middleware.ts` (`wrapTool` with permission check, HITL approval, hooks)
- Prompt compiler: `packages/core/prompt-compiler.ts` (5-layer system prompt assembly)
- Delegation: `packages/core/delegation.ts` (restricted delegate tool with depth/whitelist/cycle checks)
- Scheduler: `packages/core/scheduler.ts` (cron parser, setTimeout-based timer, JSONL persistence)
- Scheduler tools: `packages/core/scheduler-tools.ts` (`schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job`)
- MCP client: `packages/core/mcp-client.ts` (`McpConnector` interface for external tool servers)
- Browser wrapper: `packages/core/browser.ts` (`browseUrl`/`interactWithPage` use Playwright with SPA hydration waits + DOM snapshots including forms/inputs/buttons/iframes + heuristic selector fallback for `click`/`fill`/`select`; `searchWeb` uses DuckDuckGo HTML fetch+parse; includes launch/operation timeouts, temporary failure cooldown, and Bun→Node fallback bridge for Playwright launches)
- Browser Node bridge: `packages/core/browser-node-bridge.mjs` (runs Playwright under `node` when Bun runtime cannot establish Chromium connection)
- Explorer tools: `packages/core/explorer-tools.ts` (`browse_url`, `search_web`, `interact_page` tool entries)
- Credential store: `packages/core/credential-store.ts` (AES-256-GCM encrypted credential storage)
- Credential tools: `packages/core/credential-tools.ts` (`request_credentials` asks user for keys via HITL and stores them encrypted by domain)
- Analyst tools: `packages/core/analyst-tools.ts` (`query_sqlite`, `query_supabase`, `parse_csv`, `analyze_data` tool entries)
- Office tools: `packages/core/office-tools.ts` (`read_excel`, `write_excel` via exceljs; `read_docx`, `write_docx` via mammoth + docx)
- Debugger tools: `packages/core/debugger-tools.ts` (`read_file`, `search_code`, `list_directory` tool entries)
- Marketing tools: `packages/core/marketing-tools.ts` (`seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar` — assigned to `marketing`)
- Graphic designer tools: `packages/core/graphic-designer-tools.ts` (`generate_image` via Gemini Imagen 3; `canva_create`, `canva_get`, `canva_export` via Canva Connect API; `figma_get`, `figma_export` via Figma REST API — assigned to `graphic-designer`)
- Workspace manager: `packages/core/workspace-manager.ts` (persists workspaces, active workspace, allowed roots in `.runtime-data/workspaces.json`)
- Workspace tools: `packages/core/workspace-tools.ts` (`workspace_roots`, `workspace_list`, `workspace_get_active`, `workspace_register`, `workspace_set_active`)
- Git tools: `packages/core/git-tools.ts` (`git_*` and `github_*` tools running on the active workspace; PR actions via `gh`)
- Orchestrator local file access: runtime combines delegation tools with HITL-gated local file tools (`read_file`, `search_code`, `list_directory`)
- Orchestrator terminal access: runtime also exposes HITL-gated `run_command` with `powershell`/`bash` shell mode, plus `request_credentials` for secure key capture in UI/CLI
- Google auth: `packages/core/google-auth.ts` (OAuth2 helper — reads from CredentialStore domain `"google"` or env vars `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`)
- Google Sheets tools: `packages/core/google-sheets-tools.ts` (`read_gsheet`, `write_gsheet`, `create_gsheet` — assigned to `math`)
- Google Docs tools: `packages/core/google-docs-tools.ts` (`read_gdoc`, `write_gdoc`, `create_gdoc` — assigned to `writer`)
- Google Drive tools: `packages/core/google-drive-tools.ts` (`drive_list`, `drive_search`, `drive_download` — assigned to `explorer`)
- Google Mail tools: `packages/core/google-mail-tools.ts` (`gmail_search`, `gmail_read` assigned to `secretary`; `gmail_send`, `gmail_draft` assigned to `writer`)
- Google Calendar tools: `packages/core/google-calendar-tools.ts` (`calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete` — assigned to `secretary`)
- Local contacts tools: `packages/core/local-contacts-tools.ts` (`contacts_list`, `contacts_read`, `contacts_search`, `contacts_create`, `contacts_delete` — assigned to `secretary`)
- Google Tasks tools: `packages/core/google-tasks-tools.ts` (`tasks_list`, `tasks_create`, `tasks_complete` — assigned to `secretary`)
- Chat orchestration: `packages/core/chat-manager.ts` (per-agent concurrency with FIFO queue, timeout/retry, HITL timeout pause/resume, disk persistence and restore)
- Persistence: `packages/core/thread-store.ts` (threads, traces, chat records — atomic append, fault-tolerant JSONL)
- Web UI state hydration: `apps/web/ui-state.ts` (rebuilds persisted chat/delegation/trace view, plus chats/jobs, so F5/Ctrl+R keeps session context)
- Web UI runtime state: `apps/web/runtime-context.tsx` (shared reducer + REST hydration + WebSocket lifecycle, kept stable across route changes)
- Web UI router shell: `apps/web/app.tsx` mounts `react-router-dom`; `apps/web/layouts/dashboard-layout.tsx` keeps the persistent header/nav around routed pages; the chat input bar is shown only on `/` (chat route)
 - Web UI styling: `apps/web/app.css` now defines Sacred-inspired theme tokens + Tailwind entrypoint; dark theme is the default and a nav switcher persists the user's preference; `apps/web/app.generated.css` is the compiled stylesheet served by `index.html`
 - Web UI utilities: `apps/web/lib/utils.ts` (`cn`) and `apps/web/lib/agent-colors.ts` (per-agent Sacred tint mapping + shared status badge styles)
 - shadcn/ui config: root `components.json` + TS path aliases are configured so the CLI can target `apps/web`; in this cloud environment, `shadcn add` still fails unless `bun` is available in PATH because the CLI shells out to `bun add`
- Error utilities: `packages/core/errors.ts` (`errorMessage`, `safeAsync`, `safeParseLine`)
- Contracts: `packages/core/contracts.ts`

### Runtime goals

- Chat-based delegation: each delegation = a chat between orchestrator and specialist.
- All delegation is async. No sync path.
- Per-agent concurrency via `maxConcurrency` (default 1) with FIFO queue for overflow.
- Persist thread envelopes, traces, and chat records for auditability.
- Dithie/orchestrator can inspect local filesystem paths through HITL approvals.
- Dithie/orchestrator can run terminal commands through HITL (`run_command`, including `powershell`/`bash` shell mode).
- Dithie/orchestrator can request credentials from the user through HITL forms (`request_credentials`) and persist them encrypted in `CredentialStore`.
- `code` and `web-designer` can manage local workspaces and run git/GitHub workflows (`workspace_*`, `git_*`, `github_*`).
- Runtime defaults to unrestricted filesystem roots for workspace registration; set `WORKSPACE_ALLOWED_ROOTS` to enforce path limits.
- User→orchestrator turns wait for delegated chats created in that run to close before final reply.
- Delegated chat timeout defaults to 180s; `explorer`, `web-designer`, and `marketing` delegations use 300s.
- Delay UI work until `ui:gate` indicates clear operational friction.
- Math specialist defaults to short result-only replies unless user asks for steps.

## Operational Runbook

Use these project scripts:

- `bun run start`
- `bun run start -- --session <id>`
- `bun test`
- `bun run typecheck`
- `bun run smoke:math`
- `bun run smoke:code`
- `bun run smoke:orchestrator`
- `bun run smoke:explorer`
- `bun run smoke:writer`
- `bun run smoke:debugger`
- `bun run smoke:web-designer`
- `bun run smoke:marketing`
- `bun run smoke:graphic-designer`
- `bun run ui` (Dithie web dashboard with per-agent views)
- `bun run ui:gate`

Explorer prerequisite:
- Install Playwright browser binary once: `bunx playwright install chromium`
- Ensure outbound internet access (DNS + HTTPS) is available for web tools
- Browser launch timeout is set to 30s for slower environments
- When running runtime with Bun, ensure `node` is in `PATH` for Playwright bridge fallback
- Env override: `PLAYWRIGHT_NODE_BRIDGE=1` force Node bridge, `PLAYWRIGHT_NODE_BRIDGE=0` disable it

Marketing prerequisite:
- `MARKETING_SHEET_ID` env var or CredentialStore domain `"marketing"` -- Google Sheets spreadsheet ID used by `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`

Graphic designer prerequisites:
- `GEMINI_API_KEY` env var or CredentialStore domain `"gemini"` (field: `apiKey`) — Google AI Studio API key for Imagen 3 image generation
- `CANVA_API_KEY` env var or CredentialStore domain `"canva"` (field: `apiKey`) — Canva Connect API key
- `FIGMA_ACCESS_TOKEN` env var or CredentialStore domain `"figma"` (field: `accessToken`) — Figma personal access token

Git/GitHub prerequisite:
- `git` installed and available in `PATH`
- `gh` installed and authenticated (`gh auth login`) for `github_create_pr` / `github_merge_pr`

Inside the CLI, useful commands:

- `/agents`, `/use <agentId>`
- `/traces [n]`
- `/threads`, `/thread <threadId>`
- `/chats`, `/chat <chatId> [--json]`, `/close <chatId>`
- `/scheduled [jobId]` — list scheduled jobs or inspect one
- `/cancel-job <jobId>` — cancel a scheduled job
- Legacy aliases: `/jobs`=/chats, `/job`=`/task`=/chat, `/cancel`=/close

## Data and Trace Expectations

### Thread envelope minimum fields

- `threadId`, `fromAgentId`, `toAgentId`
- `runId`, `turnId`
- `chatId?`, `toolCallId?`
- `parentEnvelopeId?`, `replyToEnvelopeId?`

### Trace correlation requirements

When adding or changing runtime behavior, preserve correlation IDs:

- `sessionId`
- `runId`
- `turnId`
- `toolCallId` (for tool lifecycle)
- `chatId` (for delegated work)

## Development Guardrails

- **IMPORTANT: When making any change, review and update `README.md`, `CLAUDE.md`, and `AGENTS.md` to keep documentation in sync with the code.** These three files must always reflect the current state of the project.
- Do not remove backward compatibility alias `delegate_task` unless explicitly requested.
- Prefer adding new capability through explicit tools rather than implicit behavior.
- If you modify delegation, update both:
  - traces (`tool_start/tool_end`, `chat_*`), and
  - thread persistence (`ThreadEnvelope` metadata).
- Avoid introducing hidden state; keep state reconstructable from persisted files.
- If changing CLI commands, update `README.md` in the same change.

## Error Handling Patterns

- Use `errorMessage(err)` from `packages/core/errors.ts` to extract message from unknown errors. Never inline `err instanceof Error ? err.message : String(err)`.
- Use `safeAsync(fn, label)` for fire-and-forget async operations (hooks, persistence). Logs to stderr on failure, returns `undefined`.
- Use `safeParseLine<T>(line)` for JSONL fault-tolerant parsing. Returns `undefined` on corrupt lines.
- Guard `trace()` and persistence calls with try-catch so trace failures don't shadow original errors.
- CLI commands must be wrapped in try-catch — use `cliError(err)` helper in `apps/cli/index.ts`.
- Task input validation: `MAX_TASK_LENGTH = 10_000` in `packages/core/tools.ts`.
- Runtime response extraction ignores intermediate `toolUse` assistant turns, strips leaked `thought:` prefixes, and falls back to completed `get_chat_result` output when the final assistant message is empty.

## Chat Persistence

- Chats persist to `chats.jsonl` via `ThreadStore.appendChatRecord()`.
- Each state change (active/waiting/closed) appends the full record.
- On restore, `ChatManager.restore()` reads records from disk, marks interrupted chats as closed.
- The `ChatManager` constructor accepts optional `persistChat`, `restoreRecords`, and `getMaxConcurrency` callbacks.

## Model Configuration

Agents are defined via the builder pattern in `packages/core/agents.ts` using `defineAgent()`.
Current setup keeps same model for all agents.

- `orchestrator` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: delegation/chat tools + `read_file`, `search_code`, `list_directory`, `run_command`, `request_credentials` with HITL)
- `code` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: dev tools + `workspace_*` + `git_*` + `github_*`; delegates frontend to `web-designer`)
- `web-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: dev tools + frontend tools + `browse_url` + `workspace_*` + `git_*` + `github_*`; delegates backend to `code`)
- `math` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: analyst tools + `read_excel`, `write_excel`, `read_gsheet`, `write_gsheet`, `create_gsheet`)
- `explorer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: browser + `drive_list`, `drive_search`, `drive_download`)
- `writer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `read_docx`, `write_docx`, `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft`)
- `debugger` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `secretary` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `gmail_search`, `gmail_read`, calendar, internal contacts, tasks + scheduler tools)
- `marketing` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url`; delegates to `writer`, `explorer`, `secretary`)
- `graphic-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `generate_image`, `canva_create`, `canva_get`, `canva_export`, `figma_get`, `figma_export`, `search_web`, `browse_url`; delegates to `explorer`)

## Agent Builder Pattern

Define agents declaratively:

```ts
const agent = defineAgent("myAgent")
  .name("My Agent")
  .role("Does things")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt("You are a helpful agent.")
  .capabilities(["cap1", "cap2"])
  .tools(["tool1", "tool2"])         // tool refs resolved from ToolRegistry
  .permissions({ "tool1": "allow" }) // per-tool permission overrides
  .maxConcurrency(1)
  .build();
```

## Tool Permissions & HITL

Tools have a `defaultPermission` of `"allow"`, `"deny"`, or `"hitl"`.
Resolution order: runtime override → agent permissions → exact match → glob pattern → default.

When permission resolves to `"hitl"`, the `HITLHandler` is called to prompt the user for approval.

- CLI: readline prompt in terminal
- Web: WebSocket request/response with configurable timeout
- Web UI: modal with `Allow` / `Don't Allow` buttons and keyboard shortcuts `y` / `n`
- Web UI forms: `request_credentials` renders secure text/password fields and responds with `modifiedParams`.
- Backend starts HITL timeout only after the UI acknowledges request receipt (`hitl_seen`), preventing silent timeout without modal display.
- Delegated chat timeout is paused while waiting on HITL approval and resumed after HITL resolves.
- Repeated HITL pauses in the same delegated chat preserve remaining timeout correctly across each pause/resume cycle.
- If no UI is connected, HITL requests remain queued until a UI client connects and acknowledges.
- Backend logs HITL dispatch/response/timeout with `[hitl] ...` lines to aid debugging.

## Google Workspace Integration

Google API tools use OAuth2 via `googleapis`. Credential resolution order:

1. CredentialStore domain `"google"` (fields: `clientId`, `clientSecret`, `refreshToken`)
2. Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
3. Optional interactive flow: orchestrator can call `request_credentials` to collect/store values through HITL UI.

Agent tool assignments:

- `math`: `read_gsheet`, `write_gsheet`, `create_gsheet`
- `writer`: `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft`
- `explorer`: `drive_list`, `drive_search`, `drive_download`
- `secretary`: `gmail_search`, `gmail_read`, `calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete`, `tasks_list`, `tasks_create`, `tasks_complete` + scheduler tools
- `marketing`: `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url` (Google Sheets via `MARKETING_SHEET_ID`; delegates to `writer`, `explorer`, `secretary`)

Secretary also includes internal contacts tools:
- `contacts_list`, `contacts_read`, `contacts_search`, `contacts_create`, `contacts_delete`

## Scheduler

The runtime includes a `Scheduler` for cron, one-time, and delayed task execution.

- Jobs persist to JSONL and restore on restart.
- Agent tools: `schedule_task` (hitl), `list_scheduled_jobs` (allow), `cancel_scheduled_job` (hitl) — assigned to `secretary` (migrated from `orchestrator`).
- Config-driven schedules can be passed via `RuntimeOptions.schedules`.

## Debug Checklist

If behavior is unexpected:

1. Start a fresh session (`--session`).
2. Reproduce with `orchestrator` and inspect `/traces 30`.
3. Inspect internal thread (`/threads`, `/thread <id>`).
4. Inspect chat view (`/chat <chatId>`), or raw inspection (`/chat <chatId> --json`).
5. Run `bun run typecheck`.
6. If answer is empty, inspect `/thread <id>` for `Model error: ...` (often provider rate-limit/quota).

## Web UI — Dithie Dashboard

Entry point: `apps/backend/server.ts` — independent from the CLI, shares `MultiAgentRuntime`.

Run with:
```bash
bun run ui -- --session <id>
```
Serves on http://localhost:3000.

### Design
- **B&W monochromatic palette**: `#000` bg, `#fff` text, grey surfaces/borders. No colors.
- **Dithie**: pixel-art spider character as orchestrator identity. States: idle (breathing + blink), thinking (eye movement cycle), delegating (eyes shifted), error (X eyes).
- **Persistent shell + router**: header and top nav stay mounted while React Router swaps pages; the chat input bar appears only on `/` (conversation route).
- **Routes**: `/` (chat), `/traces`, `/agents`, `/chats`, `/jobs`.
- **Refresh restore**: F5/Ctrl+R rehydrates persisted chat, delegations, traces, chats and jobs via REST before WS reconnect.
- **SPA fallback**: `apps/backend/server.ts` serves the HTML shell for all client routes above, so direct navigation and reloads work outside `/`.

### Files
- `apps/backend/server.ts`: `Bun.serve()` with REST routes + WebSocket at `/ws`. Also serves the SPA shell for `/`, `/chat`, `/traces`, `/agents`, `/chats`, `/jobs`.
- `apps/web/app.tsx`: React Router bootstrap with `createBrowserRouter`.
- `apps/web/runtime-context.tsx`: shared reducer, `/api/ui-state` hydration, WebSocket lifecycle, live updates for traces/chats/jobs.
- `apps/web/layouts/dashboard-layout.tsx`: persistent shell with header and nav; input bar only on `/`.
- `apps/web/pages/chat-page.tsx`: conversation view + trace sidebar.
- `apps/web/pages/traces-page.tsx`: full trace explorer page.
- `apps/web/pages/agents-page.tsx`: runtime agent catalog.
- `apps/web/pages/chats-page.tsx`: delegated chat inspector.
- `apps/web/pages/jobs-page.tsx`: scheduler job overview.
- `apps/web/components/chat-ui.tsx`: input + message/delegation feed components.
- `apps/web/components/trace-ui.tsx`: reusable trace list/panel.
- `apps/web/components/nav.tsx`: top-level route navigation.

## UI / Monorepo Decision Rule

Stay terminal-first by default. Consider UI (and Turbo monorepo split) only when at least one is true:

- parallel task pressure is recurrent,
- HITL actions become frequent,
- trace volume makes terminal-only debugging inefficient.

## Multi-org + WhatsApp (Kapso) addendum (2026-03)

This section supersedes older single-orchestrator assumptions for backend/UI runtime behavior.

Architecture updates:

- New `RuntimeManager` (`packages/core/runtime-manager.ts`) manages `orgId -> OrgRuntime` with lazy load.
- Persisted data for backend/UI is isolated per org under `.runtime-data/orgs/<orgId>/`.
- Orchestrators are dynamic per org (`orchestrator:<id>`), not only `orchestrator`.
- Specialists remain shared per org, with FIFO queueing enforced by chat manager per specialist.
- Runtime turn context includes external channel metadata (`initiator: "external"`, `channel`, `contact`, `orchestratorId`).

Kapso adapter updates:

- `POST /api/kapso/webhooks/project`: handles `whatsapp.phone_number.created` and binds `phone_number_id` to orchestrator channel config.
- `POST /api/kapso/webhooks/phone-number/:phoneNumberId`: handles `whatsapp.message.*` and `whatsapp.conversation.*`.
- Webhook signature verification via `X-Webhook-Signature` (HMAC SHA-256 over raw body).
- Idempotency dedupe via `X-Idempotency-Key`.

Strict owner routing rule:

- `owner_number` is mandatory for active WhatsApp orchestrator channels.
- If inbound number != configured owner: message is blocked before runtime, not routed, not persisted in chat thread.
- A technical `communication_intent` record is appended for audit/debug.

UI + channel behavior:

- Conversation context is `orgId + orchestratorId + contact`.
- Inbox supports filter by orchestrator.
- Unified thread shows WhatsApp inbound/outbound plus internal UI messages.
- UI-originated messages must stay internal (do not dispatch to WhatsApp transport).
- WS events include channel activity and delivery states (`sent`, `delivered`, `read`, `failed`) plus `communication_intent`.

New/updated backend routes:

- `GET /api/orgs/:orgId/orchestrators`
- `POST /api/orgs/:orgId/orchestrators/:orchestratorId/setup-link`
- `POST /api/kapso/webhooks/project`
- `POST /api/kapso/webhooks/phone-number/:phoneNumberId`
- `GET /api/conversations`
- `GET /api/channel-events`
- `GET /api/communication-intents`
- `GET /api/ui-state` with `orgId`, `orchestratorId`, `contact`

Kapso env vars:

- `KAPSO_API_KEY` (required for setup link and outbound send)
- `KAPSO_API_BASE_URL` (optional, default `https://api.kapso.ai`)
- `KAPSO_PROJECT_WEBHOOK_SECRET`, `KAPSO_PHONE_WEBHOOK_SECRET` (or fallback `KAPSO_WEBHOOK_SECRET`)
- `DEFAULT_ORG_ID` for backend/UI default org selection

## Business + deployment model (cloud multi-tenant)

The intended product model is a cloud-hosted multi-tenant service.

- One cloud backend process can host many organizations (`orgId`) through `RuntimeManager`.
- Each organization has isolated runtime data and channel configuration.
- Each organization can have multiple orchestrators (`orchestrator:<id>`), and each orchestrator can map to its own WhatsApp number.
- Specialists are shared within an organization (not across organizations).
- Queueing guarantees:
  - FIFO per specialist (chat manager)
  - FIFO per channel conversation (`orgId + orchestratorId + contact`)

Product/business implications:

- Org-level onboarding (org creation, orchestrator provisioning, Kapso setup-link flow).
- Multi-customer SaaS operation with strict tenant isolation by org.
- Org-level auditability (`threads`, `traces`, `chats`, `channel-events`, `communication-intents`).
- Strict channel ownership gate (`owner_number`) to prevent cross-contact misuse.
