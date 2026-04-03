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
- UI gate entry point: `apps/backend/ui-gate.ts`
- Runtime: `packages/core/runtime.ts`
- Tools: `packages/core/tools.ts`
- Agents: `packages/core/agents.ts` (agent definitions via builder pattern)
- Agent builder: `packages/core/agent-builder.ts` (`defineAgent().name().model().tools().skills(...).build()`)
- Skills layer: `packages/core/skills-layer.ts` (loads local `SKILL.md` files from `./skills`, picks relevant skills per turn, and appends bounded context to prompts)
- Project skills root: `skills/` (includes a vendored `marketingskills` snapshot at `skills/marketingskills`)
- Tool registry: `packages/core/tool-registry.ts` (register/resolve tools with glob patterns, MCP lifecycle)
- Tool middleware: `packages/core/tool-middleware.ts` (`wrapTool` with permission check, HITL approval, hooks)
- Prompt compiler: `packages/core/prompt-compiler.ts` (5-layer system prompt assembly)
- Delegation: `packages/core/delegation.ts` (restricted delegate tool with depth/whitelist/cycle checks)
- Scheduler: `packages/core/scheduler.ts` (cron parser, setTimeout-based timer, JSONL persistence)
- Scheduler tools: `packages/core/scheduler-tools.ts` (`schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job`)
- MCP client: `packages/core/mcp-client.ts` (`McpConnector` interface for external tool servers)
- Browser wrapper: `packages/core/browser.ts` (`browseUrl` calls Python microservice → Crawl4AI; `searchWeb` calls SearXNG REST API directly; `interactWithPage` calls Python microservice → browser-use LLM-driven automation)
- Phone utils: `packages/core/phone-utils.ts` (normalizes contact numbers for thread ids, restore, and channel routing)
- Explorer tools: `packages/core/explorer-tools.ts` (`browse_url`, `search_web`, `interact_page` tool entries; `interact_page` uses natural language `task` parameter — browser-use decides actions autonomously; supports `{{credential:fieldname}}` placeholders in task string)
- Browser-use interactor: `services/browse-service/interactor.py` (extends browser-use prompt with global safety rules + vendored interaction skill + domain skills; `interact_page` now returns a structured `Interaction Report` for better downstream interpretation including judge validation + observed blockers; uses browser-use `ChatOpenRouter` with `ChatOpenAI` fallback for compatibility; retries once by default with blocker-aware previous-attempt context when validation fails).
- Credential store: `packages/core/credential-store.ts` (AES-256-GCM encrypted credential storage)
- Credential tools: `packages/core/credential-tools.ts` (`request_credentials` asks user for keys via HITL and stores them encrypted by domain)
- Analyst tools: `packages/core/analyst-tools.ts` (`query_sqlite`, `query_supabase`, `parse_csv`, `analyze_data` tool entries)
- Office tools: `packages/core/office-tools.ts` (`read_excel`, `write_excel` via exceljs; `read_docx`, `write_docx` via mammoth + docx)
- Dev tools: `packages/core/dev-tools.ts` (`read_file`, `write_file`, `edit_file`, `search_code`, `list_directory`, `run_command` — shared by `code` and `web-designer`)
- Frontend tools: `packages/core/frontend-tools.ts` (`preview_page`, `check_responsive`, `validate_accessibility` — assigned to `web-designer`)
- Marketing tools: `packages/core/marketing-tools.ts` (`seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar` — assigned to `marketing`)
- Graphic designer tools: `packages/core/graphic-designer-tools.ts` (`generate_image` via Gemini Imagen 3; `canva_create`, `canva_get`, `canva_export` via Canva Connect API — assigned to `graphic-designer`; Figma is connected via MCP server `@figma/mcp`, auto-injected as `mcp:figma/*` when `FIGMA_ACCESS_TOKEN` is set)
- Debugger tools: `packages/core/debugger-tools.ts` (`read_file`, `search_code`, `list_directory` tool entries)
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
- Google Contacts tools: `packages/core/google-contacts-tools.ts` (`contacts_search`, `contacts_create` — assigned to `secretary`)
- Google Tasks tools: `packages/core/google-tasks-tools.ts` (`tasks_list`, `tasks_create`, `tasks_complete` — assigned to `secretary`)
- Chat orchestration: `packages/core/chat-manager.ts` (per-agent concurrency with FIFO queue, timeout/retry, HITL timeout pause/resume, disk persistence and restore)
- Persistence: `packages/core/thread-store.ts` (threads, traces, chat records — atomic append, fault-tolerant JSONL)
- Deployment template: `deploy/nginx/pi-agent.conf` (Nginx reverse proxy for Oracle VM; includes `/ws` WebSocket upgrade headers)
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
- Runtime can augment any agent prompt with local skills context (`SKILL.md`) when available.
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
- `bun run ui:gate`
- `docker compose up --build -d` (backend + explorer support stack)
- `docker compose down`
- `PI_BACKEND_PORT=3001 docker compose up --build -d` (optional override if port 3000 is busy)

Engram prerequisite (memory layer):

- Start engram before running any agent that uses memory: `docker-compose up engram -d`
- Set env vars for local dev (no Docker):
  - `ENGRAM_URL=http://localhost:7437` (default)
  - `ENGRAM_SESSION_ID=pi-agent` (default)
- Thread compaction env vars (optional, defaults shown):
  - `COMPACTION_THRESHOLD=80` — trigger compaction when orchestrator has more than this many messages
  - `COMPACTION_KEEP=10` — keep this many recent messages after compaction
  - `TRACES_MAX_LINES=5000` — rotate traces.jsonl after this many lines

Explorer prerequisite:

- Start supporting services before running explorer agent or smoke test:
  - `docker compose up searxng pi-browse-service -d`
  - Or run SearXNG manually: `docker run -p 8080:8080 -v ./services/searxng:/etc/searxng searxng/searxng:latest`
  - Or run Python service manually: `cd services/browse-service && uvicorn main:app --port 8001`
- Set env vars for local dev (no Docker):
  - `SEARXNG_URL=http://localhost:8080` (default)
  - `BROWSE_SERVICE_URL=http://localhost:8001` (default)
  - `BROWSE_TIMEOUT_MS=90000` (optional, TS client timeout for `browse_url`)
  - `BROWSE_PAGE_TIMEOUT_MS=60000` (optional, Python crawl page timeout)
  - `BROWSE_WAIT_FOR_TIMEOUT_MS=10000` (optional, max wait for `wait_for` selectors before fallback)
- Python service requires `OPENROUTER_API_KEY` for `interact_page` (browser-use LLM)
- `BROWSE_LLM_MODEL` overrides the LLM model used by browser-use (default: `openrouter/google/gemini-3.1-flash-lite-preview`)
- `BROWSE_INTERACT_MAX_RETRIES=1` (optional, extra retries for `interact_page` when judge/runtime signals mark extraction as unreliable)
- Vendored interaction skill lives at `skills/browser/_official/interaction/SKILL.md`.
- `BROWSE_OFFICIAL_SKILL_MAX_CHARS=2500` (optional, max chars per interaction skill injected into `interact_page`).
- `BROWSE_OFFICIAL_SKILL_TOTAL_MAX_CHARS=5000` (optional, max combined chars from interaction skills injected into `interact_page`).

Marketing prerequisite:

- `MARKETING_SHEET_ID` env var or CredentialStore domain `"marketing"` — Google Sheets spreadsheet ID used by `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`

Graphic designer prerequisites:

- `GEMINI_API_KEY` env var or CredentialStore domain `"gemini"` (field: `apiKey`) — Google AI Studio API key for Imagen 3 image generation
- `CANVA_API_KEY` env var or CredentialStore domain `"canva"` (field: `apiKey`) — Canva Connect API key
- `FIGMA_ACCESS_TOKEN` env var — Figma personal access token (runtime auto-connects `@figma/mcp` via stdio when set; tools injected as `mcp:figma/*`)

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
- Task input validation: `MAX_TASK_LENGTH = 10_000` in `packages/core/tools.ts`; delegate tasks are otherwise free-form text (no parenthesis-balance enforcement).
- Runtime response extraction ignores intermediate tool-use assistant turns, strips leaked `thought:` prefixes, falls back to completed `get_chat_result` output when needed, and is scoped to current-turn messages to avoid stale-answer reuse after provider errors.
- History pruning/compaction now preserves tool-call boundaries: if a window starts on `toolResult`, runtime either includes the matching prior `toolCall` or drops orphan results. This prevents provider errors like `No tool call found for function call output with call_id ...`.
- Runtime subscribes to `tool_execution_start` / `tool_execution_end` and persists execution-phase `tool_start` / `tool_end` traces with sanitized args/details. For `interact_page`, `task` is redacted and only `taskLength` is stored.
- `wrapTool` logs tool exceptions to stderr as `[tool-error] agent=<id> tool=<name> call=<toolCallId>: ...` before re-throwing.
- Browser wrapper errors for `browse_url` / `interact_page` now include HTTP status/body snippets and explicit timeout messages; logs use `[browser] ... failed` and never print `interact_page` task content.

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
- `math` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: analyst tools + `read_excel`, `write_excel`, `read_gsheet`, `write_gsheet`, `create_gsheet`)
- `explorer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: browser + `drive_list`, `drive_search`, `drive_download` + `get_credential_fields`, `request_credentials`)
- `writer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `read_docx`, `write_docx`, `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft`)
- `web-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: dev tools + frontend tools + `browse_url` + `workspace_*` + `git_*` + `github_*`; delegates backend to `code`)
- `debugger` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `secretary` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `gmail_search`, `gmail_read`, calendar, internal contacts, tasks + scheduler tools)
- `marketing` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url`; delegates to `writer`, `explorer`, `secretary`)
- `graphic-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `generate_image`, `canva_create`, `canva_get`, `canva_export`, `mcp:figma/*` (auto-injected via `@figma/mcp` when `FIGMA_ACCESS_TOKEN` set), `search_web`, `browse_url`; delegates to `explorer`)

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
  .skills({ enabled: true, roots: ["skills"] }) // optional local skill layer
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
- **WhatsApp**: when the originating run has `channel === "whatsapp"`, the backend sends a WA message asking for approval. The owner replies *si*/*no* (or *yes*/*ok*/*s*/*n* etc.) to resolve. Webhook handler intercepts matching replies before routing to the agent. Timeout starts immediately after WA send (no `hitl_seen`).
- Dual-channel: UI modal is always shown in parallel; either the UI or WA reply resolves first.
- `HITLRequest` carries `channel?`, `contact?`, `orgId?`, `orchestratorId?` populated from `RunContext` via `getRunContext` in `wrapTool`.
- `RuntimeManager.sendChannelMessage(orgId, orchestratorId, contact, body)` is the send path for WA HITL messages.
- `hitlContactIndex` in `server.ts` maps normalized contact → reqId for fast WA reply lookup.
- Backend starts HITL timeout (UI path) only after the UI acknowledges receipt (`hitl_seen`).
- Delegated chat timeout is paused while waiting on HITL approval and resumed after HITL resolves.
- Repeated HITL pauses in the same delegated chat preserve remaining timeout correctly across each pause/resume cycle.
- If no UI is connected, HITL requests remain queued until a UI client connects and acknowledges.
- Backend logs HITL dispatch/response/timeout with `[hitl] ...` lines to aid debugging.

## Google Workspace Integration

Google API tools use OAuth2 via `googleapis`. Credential resolution order:

1. CredentialStore domain `"google"` (fields: `clientId`, `clientSecret`, `refreshToken`)
2. Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
3. Optional interactive flow: orchestrator can call `request_credentials` to collect/store values through HITL UI.
4. Prompt behavior: Google-capable agents should assume access is already configured and only ask for credentials if a Google tool returns an auth/permission error.

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

Serves on <http://localhost:3000>.

### Design

- **Sacred-inspired palette**: esquema basado en los tokens de `sacred.computer`/SRCL (`--theme-*`, tintes OKLCH y grises neutrales), manteniendo la UI existente pero con un sistema de color más rico.
- **Dithie**: pixel-art spider character as orchestrator identity. States: idle (breathing + blink), thinking (eye movement cycle), delegating (eyes shifted), error (X eyes).
- **Unified chat**: all conversation goes through Dithie (orchestrator). No agent switching. Delegations shown as collapsible inline blocks.
- **Chat anchor-on-send**: in the main chat route (`/`), once Dithie starts streaming, the just-sent user message is smoothly aligned near the top of the message container and no post-stream jump-to-bottom is triggered.
- **Breathing last turn**: the last assistant turn reserves viewport space above the composer so replies do not visually collide with the input bar.
- **Context-preserving replies**: UI sends include the active `orgId`, `orchestratorId`, and normalized `contact`, so restored conversations keep replying into the same thread.
- **Inline thinking traces**: the chat feed consumes only native orchestrator `thinking_start/delta/end` events from `pi-ai` in real time (not sidebar-only), shows the full reasoning text for debugging in a lighter floating block, extracts a heading-like first line into the block header, highlights later heading-like lines inside the body, and keeps the block visible while the final answer streams.
- **Per-turn ordering**: on hydrate and live replay, each run's thinking block stays before that run's final assistant reply.
- **Thinking hydration**: on `/api/ui-state` restore, thinking blocks are rebuilt from persisted orchestrator assistant messages (`content.type === "thinking"`) scoped to the selected thread/run set.
- **Pre-stream**: while waiting for the first token after `chat_sending`, the chat does not invent a reasoning block; it only renders thinking after native `thinking_*` events arrive.
- **React Router UI**: shell persistente con rutas para `chat`, `traces`, `agents`, `chats` y `jobs`.
- **Chat route**: mantiene el split principal Chat panel (flex:1) | Trace panel (280px fixed).
- **Refresh restore**: F5/Ctrl+R rehydrates persisted session chat, delegation blocks, and traces via REST before WS reconnect.
- **Ops snapshots**: `/api/ui-state` hidrata también `chats` y `jobs` para que las vistas operativas arranquen sin loaders extra.
- **Tailwind UI**: el layout y los componentes usan utilidades Tailwind; `apps/web/app.css` queda como capa global de tokens/animaciones y `apps/web/app.generated.css` es el artefacto compilado servido por la SPA.
- **Dark by default**: la UI carga en tema oscuro por defecto.
- **Theme switcher**: la barra de navegación incluye un selector `dark/light` persistido en `localStorage`.
- **Agent colors**: la vista `/agents` asigna un tinte Sacred por agente para distinguirlos visualmente.
- **Font**: JetBrains Mono via Google Fonts CDN.

### Files

- `apps/backend/server.ts`: `Bun.serve()` with REST routes + WebSocket at `/ws`. Monkey-patches `store.appendTrace` for real-time trace push + delegation event tracking (`delegation_start`/`delegation_end`). Also patches `store.appendChatRecord` and `store.appendJob`. Exposes `/api/ui-state` for reload hydration, scoped traces, and normalized contact thread lookup.
- `apps/web/index.html`: HTML shell (title "dithie", JetBrains Mono font link).
- `apps/web/app.tsx`: entrypoint React + `createBrowserRouter()` con rutas anidadas.
- `apps/web/runtime-context.tsx`: estado global de la UI, reducer, bootstrap desde `/api/ui-state`, WebSocket persistente y preferencia de tema.
- `apps/web/layouts/dashboard-layout.tsx`: shell persistente (header, nav, `Outlet`).
- `apps/web/pages/*.tsx`: páginas separadas para chat, traces, agents, chats y jobs; en `chat-page` la barra de entrada queda dentro del panel izquierdo para que TRACES llegue al fondo.
- `apps/web/components/chat-panel.tsx`: compositor del feed principal del chat (mensajes, thinking, delegaciones, scroll/anclaje).
- `apps/web/components/ui/chat-*.tsx` / `trace-ui.tsx` / `nav.tsx`: componentes presentacionales reutilizables.
- `apps/web/lib/utils.ts`: helper `cn()` para composición de clases Tailwind.
- `apps/web/lib/agent-colors.ts`: asignación de tintes Sacred y badges/colores por agente/estado.
- `components.json`: configuración manual de shadcn adaptada a esta codebase (root package + frontend en `apps/web`) para futuras altas de componentes vía CLI.
- `apps/web/ui-state.ts`: shared snapshot builder for persisted UI hydration (messages, delegations, trace durations, primary thread lookup).
- `apps/web/app.css`: tokens globales, aliases de tema, animaciones y entrada de Tailwind.
- `apps/web/app.generated.css`: CSS compilado por Tailwind servido por `index.html`.
- `apps/web/dithie-sprite.tsx`: `DithieSprite` component — CSS Grid for 16/32px, canvas for 64px. Animation cycling per state.
- `apps/web/dithie-frames.ts`: Pixel grid data (`Frame = number[][]`) for all animation frames (idle, blink, thinking 1-4, delegating, error).

### WebSocket protocol

**Client → Server:**

- `{ type: "chat", toAgentId, content }` — send message to agent
- `{ type: "close_chat", chatId }` — cancel a chat
- `{ type: "hitl_seen", reqId }` — UI acknowledgement that HITL prompt was received
- `{ type: "hitl_response", reqId, approved, modifiedParams? }` — respond to HITL request

**Server → Client:**

- `{ type: "agents", agents, sessionId }` — on connect
- `{ type: "chat_sending", runId, toAgentId }` — before chat starts
- `{ type: "stream_delta", runId, delta }` — streaming text token
- `{ type: "stream_thinking_start|delta|end", runId, ... }` — native model reasoning stream
- `{ type: "stream_end", runId, answer, durationMs }` — chat complete
- `{ type: "stream_error", runId, error }` — chat failed
- `{ type: "trace", event }` — real-time trace push
- `{ type: "chat_lifecycle", chat }` — chat state change
- `{ type: "job_lifecycle", job }` — scheduled job state change
- `{ type: "delegation_start", runId, delegationId, fromAgentId, toAgentId, task }` — delegation began
- `{ type: "delegation_end", runId, delegationId, result, durationMs, status }` — delegation completed
- `{ type: "hitl_request", reqId, agentId, toolName, params, timeout }` — HITL approval request
- `{ type: "hitl_resolved", reqId, approved }` — HITL request was resolved
- `{ type: "hitl_expired", reqId, agentId, toolName, timeout }` — HITL request timed out

### REST API

| Route | Method | Description |
|---|---|---|
| `/api/agents` | GET | List agents |
| `/api/chats` | GET | List all chats |
| `/api/chats/:id` | GET/DELETE | Inspect or close chat |
| `/api/threads` | GET | List thread IDs |
| `/api/threads/:id` | GET | Get thread envelopes |
| `/api/traces` | GET | Get all traces |
| `/chat`, `/traces`, `/agents`, `/chats`, `/jobs` | GET | SPA fallback routes served with the web shell |
| `/api/jobs` | GET | List scheduled jobs |
| `/api/jobs/:id` | GET/DELETE | Inspect or cancel scheduled job |

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
- UI chat now sends the currently selected `orchestratorId` in WS `type: "chat"` payloads (instead of hardcoding `orchestrator`), avoiding registry mismatches in multi-orchestrator orgs.
- UI-originated messages must stay internal (do not dispatch to WhatsApp transport).
- WS events include channel activity and delivery states (`sent`, `delivered`, `read`, `failed`) plus `communication_intent`.

New/updated backend routes:

- `GET /api/orgs/:orgId/orchestrators`
- `POST /api/orgs/:orgId/orchestrators/:orchestratorId/setup-link`
- `POST /api/orgs/:orgId/orchestrators/:orchestratorId/channel` (manual upsert for `ownerNumber`, `kapsoCustomerId`, `phoneNumberId?`; useful for sandbox/local)
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
- Optional local/sandbox bootstrap (persisted channel upsert at backend start):
  - `KAPSO_BOOTSTRAP_ORG_ID` (default `DEFAULT_ORG_ID`)
  - `KAPSO_BOOTSTRAP_ORCHESTRATOR_ID` (default `main`)
  - `KAPSO_BOOTSTRAP_OWNER_NUMBER`
  - `KAPSO_BOOTSTRAP_CUSTOMER_ID`
  - `KAPSO_BOOTSTRAP_PHONE_NUMBER_ID` (optional)
  - `KAPSO_BOOTSTRAP_ACTIVE` (`true`/`false`, optional)

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
