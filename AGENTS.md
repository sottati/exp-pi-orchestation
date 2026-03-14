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
- Agents: `packages/core/agents.ts` (per-agent model config map)
- Chat orchestration: `packages/core/chat-manager.ts` (per-agent concurrency with FIFO queue, disk persistence and restore)
- Persistence: `packages/core/thread-store.ts` (threads, traces, chat records — atomic append, fault-tolerant JSONL)
- Error utilities: `packages/core/errors.ts` (`errorMessage`, `safeAsync`, `safeParseLine`)
- Contracts: `packages/core/contracts.ts`

### Runtime goals

- Chat-based delegation: each delegation = a chat between orchestrator and specialist.
- Stable conversation identity: `conversationId` is scoped to `sessionId` + agent pair and reused across delegations.
- All delegation is async. No sync path.
- Per-agent concurrency via `maxConcurrency` (default 1) with FIFO queue for overflow.
- Chats can run multi-turn loops with optional `keepAlive` and ordered follow-up queue per `chatId`.
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
- `bun run ui:gate`

Inside the CLI, useful commands:

- `/agents`, `/use <agentId>`
- `/traces [n]`
- `/threads`, `/thread <threadId>`
- `/chats`, `/chat <chatId> [--json]`, `/close <chatId>`
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
- Each chat record includes `conversationId` (stable identity) plus `chatId` (single execution).
- Each state change (active/waiting/closed) appends the full record.
- On restore, `ChatManager.restore()` reads records from disk, marks interrupted chats as closed.
- The `ChatManager` constructor accepts optional `persistChat`, `restoreRecords`, and `getMaxConcurrency` callbacks.
- Keep-alive chats remain open across turns; follow-ups are processed in FIFO order and close remains explicit.
- Closing a `chatId` does not close the stable conversation; next delegation reuses `conversationId` with a new `chatId`.

## Model Configuration

Agents use lazy model initialization with explicit per-agent config in `AGENT_MODEL_CONFIG` inside `packages/core/agents.ts`.
Current setup keeps same model for all agents.

- `orchestrator` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `code` → `openrouter/google/gemini-3.1-flash-lite-preview`
- `math` → `openrouter/google/gemini-3.1-flash-lite-preview`

## Debug Checklist

If behavior is unexpected:

1. Start a fresh session (`--session`).
2. Reproduce with `orchestrator` and inspect `/traces 30`.
3. Inspect internal thread (`/threads`, `/thread <id>`).
4. Inspect chat view (`/chat <chatId>`), or raw inspection (`/chat <chatId> --json`).
5. Run `bun run typecheck`.
6. If answer is empty, inspect `/thread <id>` for `Model error: ...` (often provider rate-limit/quota).

## UI / Monorepo Decision Rule

Stay terminal-first by default. Consider UI (and Turbo monorepo split) only when at least one is true:

- parallel task pressure is recurrent,
- HITL actions become frequent,
- trace volume makes terminal-only debugging inefficient.
