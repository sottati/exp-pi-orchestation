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
- Agent builder: `packages/core/agent-builder.ts` (`defineAgent().name().model().tools().build()`)
- Tool registry: `packages/core/tool-registry.ts` (register/resolve tools with glob patterns, MCP lifecycle)
- Tool middleware: `packages/core/tool-middleware.ts` (`wrapTool` with permission check, HITL approval, hooks)
- Prompt compiler: `packages/core/prompt-compiler.ts` (5-layer system prompt assembly)
- Delegation: `packages/core/delegation.ts` (restricted delegate tool with depth/whitelist/cycle checks)
- Scheduler: `packages/core/scheduler.ts` (cron parser, setTimeout-based timer, JSONL persistence)
- Scheduler tools: `packages/core/scheduler-tools.ts` (`schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job`)
- MCP client: `packages/core/mcp-client.ts` (`McpConnector` interface for external tool servers)
- Browser wrapper: `packages/core/browser.ts` (Playwright-based `browseUrl`, `searchWeb`, `interactWithPage`)
- Explorer tools: `packages/core/explorer-tools.ts` (`browse_url`, `search_web`, `interact_page` tool entries)
- Credential store: `packages/core/credential-store.ts` (AES-256-GCM encrypted credential storage)
- Analyst tools: `packages/core/analyst-tools.ts` (`query_sqlite`, `query_supabase`, `parse_csv`, `analyze_data` tool entries)
- Office tools: `packages/core/office-tools.ts` (`read_excel`, `write_excel` via exceljs; `read_docx`, `write_docx` via mammoth + docx)
- Debugger tools: `packages/core/debugger-tools.ts` (`read_file`, `search_code`, `list_directory` tool entries)
- Google auth: `packages/core/google-auth.ts` (OAuth2 helper — reads from CredentialStore domain `"google"` or env vars `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`)
- Google Sheets tools: `packages/core/google-sheets-tools.ts` (`read_gsheet`, `write_gsheet`, `create_gsheet` — assigned to `math`)
- Google Docs tools: `packages/core/google-docs-tools.ts` (`read_gdoc`, `write_gdoc`, `create_gdoc` — assigned to `writer`)
- Google Drive tools: `packages/core/google-drive-tools.ts` (`drive_list`, `drive_search`, `drive_download` — assigned to `explorer`)
- Google Mail tools: `packages/core/google-mail-tools.ts` (`gmail_search`, `gmail_read` assigned to `secretary`; `gmail_send`, `gmail_draft` assigned to `writer`)
- Google Calendar tools: `packages/core/google-calendar-tools.ts` (`calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete` — assigned to `secretary`)
- Google Contacts tools: `packages/core/google-contacts-tools.ts` (`contacts_search`, `contacts_create` — assigned to `secretary`)
- Google Tasks tools: `packages/core/google-tasks-tools.ts` (`tasks_list`, `tasks_create`, `tasks_complete` — assigned to `secretary`)
- Chat orchestration: `packages/core/chat-manager.ts` (per-agent concurrency with FIFO queue, disk persistence and restore)
- Persistence: `packages/core/thread-store.ts` (threads, traces, chat records — atomic append, fault-tolerant JSONL)
- Error utilities: `packages/core/errors.ts` (`errorMessage`, `safeAsync`, `safeParseLine`)
- Contracts: `packages/core/contracts.ts`

### Runtime goals

- Chat-based delegation: each delegation = a chat between orchestrator and specialist.
- All delegation is async. No sync path.
- Per-agent concurrency via `maxConcurrency` (default 1) with FIFO queue for overflow.
- Persist thread envelopes, traces, and chat records for auditability.
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
- `bun run ui:gate`

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

## Chat Persistence

- Chats persist to `chats.jsonl` via `ThreadStore.appendChatRecord()`.
- Each state change (active/waiting/closed) appends the full record.
- On restore, `ChatManager.restore()` reads records from disk, marks interrupted chats as closed.
- The `ChatManager` constructor accepts optional `persistChat`, `restoreRecords`, and `getMaxConcurrency` callbacks.

## Model Configuration

Agents are defined via the builder pattern in `packages/core/agents.ts` using `defineAgent()`.
Current setup keeps same model for all agents.

- `orchestrator` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `code` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `math` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: analyst tools + `read_excel`, `write_excel`, `read_gsheet`, `write_gsheet`, `create_gsheet`)
- `explorer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: browser + `drive_list`, `drive_search`, `drive_download`)
- `writer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `read_docx`, `write_docx`, `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft`)
- `debugger` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `secretary` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `gmail_search`, `gmail_read`, calendar, contacts, tasks + scheduler tools)

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

## Google Workspace Integration

Google API tools use OAuth2 via `googleapis`. Credential resolution order:

1. CredentialStore domain `"google"` (fields: `clientId`, `clientSecret`, `refreshToken`)
2. Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

Agent tool assignments:

- `math`: `read_gsheet`, `write_gsheet`, `create_gsheet`
- `writer`: `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft`
- `explorer`: `drive_list`, `drive_search`, `drive_download`
- `secretary`: `gmail_search`, `gmail_read`, `calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete`, `contacts_search`, `contacts_create`, `tasks_list`, `tasks_create`, `tasks_complete` + scheduler tools

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
- **Home + per-agent views**: Home keeps orchestrator chat/delegations; each specialist has a dedicated view with filtered activity and direct chat.
- **Split view**: Sidebar (56px) | Main panel (home or agent view) | Trace panel (280px fixed).
- **Font**: JetBrains Mono via Google Fonts CDN.

### Files
- `apps/backend/server.ts`: `Bun.serve()` with REST routes + WebSocket at `/ws`. Monkey-patches `store.appendTrace` for real-time trace push + delegation event tracking (`delegation_start`/`delegation_end`). Also patches `store.appendChatRecord` and `store.appendJob`.
- `apps/web/index.html`: HTML shell (title "dithie", JetBrains Mono font link).
- `apps/web/app.tsx`: React SPA with sidebar navigation, home chat, per-agent views, trace filtering, and direct-to-agent input routing.
- `apps/web/types.ts`: shared UI types and `AGENT_PERSONALITIES` config.
- `apps/web/sidebar.tsx`: agent sidebar with home button, badges, tooltips, and busy indicators.
- `apps/web/agent-view.tsx`: dedicated agent panel (identity, resources, activity/chat tabs).
- `apps/web/app.css`: B&W palette, layout grid, all component styles, animations (blink-cursor, breathe, dot-pulse).
- `apps/web/dithie-sprite.tsx`: `DithieSprite` component — CSS Grid for 16/32px, canvas for 64px. Animation cycling per state.
- `apps/web/dithie-frames.ts`: Pixel grid data (`Frame = number[][]`) for all animation frames (idle, blink, thinking 1-4, delegating, error).

### WebSocket protocol
**Client → Server:**

- `{ type: "chat", toAgentId, content }` — send message to agent
- `{ type: "close_chat", chatId }` — cancel a chat
- `{ type: "hitl_response", reqId, approved, modifiedParams? }` — respond to HITL request

**Server → Client:**

- `{ type: "agents", agents, sessionId }` — on connect
- `{ type: "chat_sending", runId, toAgentId }` — before chat starts
- `{ type: "stream_delta", runId, delta }` — streaming text token
- `{ type: "stream_end", runId, answer, durationMs }` — chat complete
- `{ type: "stream_error", runId, error }` — chat failed
- `{ type: "stream_status", runId, text }` — tool status label (ignored by Dithie UI)
- `{ type: "trace", event }` — real-time trace push
- `{ type: "chat_lifecycle", chat }` — chat state change
- `{ type: "job_lifecycle", job }` — scheduled job state change
- `{ type: "delegation_start", runId, delegationId, fromAgentId, toAgentId, task }` — delegation began
- `{ type: "delegation_end", runId, delegationId, result, durationMs, status }` — delegation completed
- `{ type: "hitl_request", reqId, agentId, toolName, params, timeout }` — HITL approval request

### REST API
| Route | Method | Description |
|---|---|---|
| `/api/agents` | GET | List agents |
| `/api/agents/:id/activity` | GET | List traces/chats/jobs filtered by agent |
| `/api/chats` | GET | List all chats |
| `/api/chats/:id` | GET/DELETE | Inspect or close chat |
| `/api/threads` | GET | List thread IDs |
| `/api/threads/:id` | GET | Get thread envelopes |
| `/api/traces` | GET | Get all traces |
| `/api/jobs` | GET | List scheduled jobs |
| `/api/jobs/:id` | GET/DELETE | Inspect or cancel scheduled job |
