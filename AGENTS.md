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

- Entry point: `src/index.ts` (interactive CLI)
- Runtime: `src/runtime.ts`
- Tools: `src/tools.ts`
- Agents: `src/agents.ts` (lazy model init via `PI_MODEL_PROVIDER`/`PI_MODEL_ID`)
- Async task orchestration: `src/task-manager.ts` (with disk persistence and restore)
- Persistence: `src/thread-store.ts` (threads, traces, task records — atomic append, fault-tolerant JSONL)
- Error utilities: `src/errors.ts` (`errorMessage`, `safeAsync`, `safeParseLine`)
- Contracts: `src/contracts.ts`

### Runtime goals

- Keep chat-like interactions between agents (e.g., `orchestrator <-> code`).
- Persist thread envelopes and traces for auditability.
- Support both sync and async delegation paths.
- Delay UI work until `ui:gate` indicates clear operational friction.

## Operational Runbook

Use these project scripts:

- `bun run start`
- `bun run start -- --session <id>`
- `bun run typecheck`
- `bun run smoke:math`
- `bun run smoke:code`
- `bun run smoke:orchestrator`
- `bun run ui:gate`

Inside the CLI, useful commands:

- `/agents`, `/use <agentId>`
- `/traces [n]`
- `/threads`, `/thread <threadId>`
- `/jobs`, `/job <jobId>`, `/task <taskId|jobId>`, `/cancel <jobId>`

## Data and Trace Expectations

### Thread envelope minimum fields

- `threadId`, `fromAgentId`, `toAgentId`
- `runId`, `turnId`
- `taskId?`, `toolCallId?`
- `parentEnvelopeId?`, `replyToEnvelopeId?`

### Trace correlation requirements

When adding or changing runtime behavior, preserve correlation IDs:

- `sessionId`
- `runId`
- `turnId`
- `toolCallId` (for tool lifecycle)
- `taskId` (for delegated work)

## Development Guardrails

- **IMPORTANT: When making any change, review and update `README.md`, `CLAUDE.md`, and `AGENTS.md` to keep documentation in sync with the code.** These three files must always reflect the current state of the project.
- Do not remove backward compatibility alias `delegate_task` unless explicitly requested.
- Prefer adding new capability through explicit tools rather than implicit behavior.
- If you modify delegation, update both:
  - traces (`tool_start/tool_end`, `task_*`), and
  - thread persistence (`ThreadEnvelope` metadata).
- Avoid introducing hidden state; keep state reconstructable from persisted files.
- If changing CLI commands, update `README.md` in the same change.

## Error Handling Patterns

- Use `errorMessage(err)` from `src/errors.ts` to extract message from unknown errors. Never inline `err instanceof Error ? err.message : String(err)`.
- Use `safeAsync(fn, label)` for fire-and-forget async operations (hooks, persistence). Logs to stderr on failure, returns `undefined`.
- Use `safeParseLine<T>(line)` for JSONL fault-tolerant parsing. Returns `undefined` on corrupt lines.
- Guard `trace()` and persistence calls with try-catch so trace failures don't shadow original errors.
- CLI commands must be wrapped in try-catch — use `cliError(err)` helper in `src/index.ts`.
- Task input validation: `MAX_TASK_LENGTH = 10_000` in `src/tools.ts`.

## Task Persistence

- Tasks persist to `tasks.jsonl` via `ThreadStore.appendTaskRecord()`.
- Each state change (queued/running/completed/failed/cancelled) appends the full record.
- On restore, `TaskManager.restore()` reads records from disk, marks interrupted tasks as failed.
- The `TaskManager` constructor accepts optional `persistTask` and `restoreRecords` callbacks.

## Model Configuration

Agents use lazy model initialization. Set via env vars (Bun loads `.env` automatically):

- `PI_MODEL_PROVIDER` (default: `openrouter`)
- `PI_MODEL_ID` (default: `openrouter/free`)

## Debug Checklist

If behavior is unexpected:

1. Start a fresh session (`--session`).
2. Reproduce with `orchestrator` and inspect `/traces 30`.
3. Inspect internal thread (`/threads`, `/thread <id>`).
4. Inspect task view (`/task <taskId|jobId>`).
5. Run `bun run typecheck`.

## UI / Monorepo Decision Rule

Stay terminal-first by default. Consider UI (and Turbo monorepo split) only when at least one is true:

- parallel task pressure is recurrent,
- HITL actions become frequent,
- trace volume makes terminal-only debugging inefficient.
