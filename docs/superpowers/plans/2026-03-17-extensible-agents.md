# Extensible Agents Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the pi-agent-core runtime so agents can have their own tools (local + MCP), enriched prompts, specialist-to-specialist delegation, HITL permissions, and persistent cron jobs.

**Architecture:** Centralized ToolRegistry per runtime instance holds all tools (local + MCP). Agent definitions use a builder pattern (`defineAgent()`) producing `AgentDefinition` objects. A single `wrapTool()` middleware handles permissions, HITL, and hooks. A Scheduler class manages persistent cron jobs with JSONL storage.

**Tech Stack:** Bun, TypeScript, `@mariozechner/pi-agent-core`, `@sinclair/typebox`, JSONL persistence.

---

## File Structure

### New Files

| File | Responsibility |
| --- | --- |
| `packages/core/tool-registry.ts` | `ToolRegistry` class — register, resolve (with globs), MCP client lifecycle |
| `packages/core/mcp-client.ts` | MCP protocol wrapper (stdio/HTTP), `McpDisconnectedError`, auto-reconnect |
| `packages/core/agent-builder.ts` | `defineAgent()` builder → `AgentDefinition` |
| `packages/core/prompt-compiler.ts` | `compileSystemPrompt()` — 5-layer prompt assembly |
| `packages/core/tool-middleware.ts` | `wrapTool()` — permission check → HITL → hooks → execute |
| `packages/core/scheduler.ts` | `Scheduler` class, `nextCronTick()` parser, job lifecycle |

### Files to Modify

| File | Change |
| --- | --- |
| `packages/core/contracts.ts` | Widen `BaseAgentId` to `string`, add `delegationDepth?`/`delegationChain?` to `RunContext`, add `Permission`, `ScheduledJob`, new trace types |
| `packages/core/thread-store.ts` | Add `appendJob()` and `getJobRecords()` |
| `packages/core/chat-manager.ts` | Add `pauseTimeout()`/`resumeTimeout()` for HITL |
| `packages/core/tools.ts` | Keep existing tools but make them registrable in ToolRegistry |
| `packages/core/agents.ts` | Rewrite with `defineAgent()` builder |
| `packages/core/runtime.ts` | New constructor accepting `AgentDefinition[]`, ToolRegistry integration, Scheduler |
| `apps/cli/index.ts` | New runtime constructor, CLI HITL handler, `/scheduled` + `/cancel-job` commands |
| `apps/backend/server.ts` | New runtime constructor, WebSocket HITL handler, `/api/jobs` routes |

### Test Files

| File | Tests |
| --- | --- |
| `packages/core/tool-registry.test.ts` | Register, resolve, glob matching, availability |
| `packages/core/mcp-client.test.ts` | Connect, disconnect, reconnect, error handling |
| `packages/core/agent-builder.test.ts` | Builder validation, all options, `.build()` output |
| `packages/core/prompt-compiler.test.ts` | Layer assembly, cap enforcement, edge cases |
| `packages/core/tool-middleware.test.ts` | Permission resolution, HITL flow, hooks, deny |
| `packages/core/scheduler.test.ts` | Cron parsing, job lifecycle, persistence, restore |

---

### Task 1: Contracts Foundation

**Files:**
- Modify: `packages/core/contracts.ts`

- [ ] **Step 1: Write tests for new contract types**

Create `packages/core/contracts.test.ts`:

```ts
import { test, expect } from "bun:test";
import type {
  Permission,
  ScheduledJob,
  RunContext,
  BaseAgentId,
  TraceEvent,
} from "./contracts";

test("BaseAgentId accepts arbitrary strings", () => {
  const id: BaseAgentId = "my-custom-agent";
  expect(id).toBe("my-custom-agent");
});

test("RunContext accepts optional delegation fields", () => {
  const ctx: RunContext = {
    runId: "run_1",
    turnId: "turn_1",
    sessionId: "s1",
  };
  expect(ctx.delegationDepth).toBeUndefined();
  expect(ctx.delegationChain).toBeUndefined();

  const ctxWithDelegation: RunContext = {
    ...ctx,
    delegationDepth: 2,
    delegationChain: ["orchestrator", "code"],
  };
  expect(ctxWithDelegation.delegationDepth).toBe(2);
  expect(ctxWithDelegation.delegationChain).toEqual(["orchestrator", "code"]);
});

test("Permission type accepts valid values", () => {
  const allow: Permission = "allow";
  const deny: Permission = "deny";
  const hitl: Permission = "hitl";
  expect([allow, deny, hitl]).toEqual(["allow", "deny", "hitl"]);
});

test("ScheduledJob has required fields", () => {
  const job: ScheduledJob = {
    jobId: "job_1",
    sessionId: "s1",
    createdBy: "orchestrator",
    targetAgentId: "code",
    task: "Run health check",
    schedule: { type: "cron", cron: "*/5 * * * *" },
    status: "active",
    runCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  expect(job.jobId).toBe("job_1");
  expect(job.schedule.type).toBe("cron");
});

test("TraceEvent type includes new event types", () => {
  const types: TraceEvent["type"][] = [
    "run_started", "run_completed", "run_failed",
    "message_routed", "tool_start", "tool_end",
    "chat_created", "chat_started", "chat_retry",
    "chat_completed", "chat_failed", "chat_cancelled",
    "tool_unavailable", "mcp_server_failed",
    "tool_permission_check", "tool_hitl_requested",
    "tool_hitl_approved", "tool_hitl_denied", "tool_hitl_timeout",
    "job_created", "job_triggered", "job_completed",
    "job_failed", "job_cancelled", "job_paused", "job_resumed",
  ];
  expect(types.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/contracts.test.ts`
Expected: FAIL — `Permission`, `ScheduledJob` types don't exist yet.

- [ ] **Step 3: Update contracts.ts with new types**

In `packages/core/contracts.ts`:

1. Change `BaseAgentId` from `"user" | "orchestrator" | "code" | "math"` to `string`.
2. Add optional fields to `RunContext`:
   ```ts
   delegationDepth?: number;
   delegationChain?: string[];
   ```
3. Add `Permission` type:
   ```ts
   export type Permission = "allow" | "deny" | "hitl";
   ```
4. Add `ScheduledJob` interface:
   ```ts
   export interface ScheduledJob {
     jobId: string;
     sessionId: string;
     createdBy: string;
     targetAgentId: string;
     task: string;
     schedule: {
       type: "cron" | "once" | "delay";
       cron?: string;
       runAt?: number;
       delayMs?: number;
     };
     status: "active" | "paused" | "completed" | "failed";
     lastRunAt?: number;
     nextRunAt?: number;
     runCount: number;
     maxRuns?: number;
     createdAt: number;
     updatedAt: number;
     error?: string;
   }
   ```
5. Add new `TraceEvent.type` values to the union:
   ```ts
   | "tool_unavailable"
   | "mcp_server_failed"
   | "tool_permission_check"
   | "tool_hitl_requested"
   | "tool_hitl_approved"
   | "tool_hitl_denied"
   | "tool_hitl_timeout"
   | "job_created"
   | "job_triggered"
   | "job_completed"
   | "job_failed"
   | "job_cancelled"
   | "job_paused"
   | "job_resumed"
   ```
6. Keep `Initiator` as-is — still a string union.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck and fix Exclude<BaseAgentId, "user"> usages**

Run: `bun run typecheck`

After widening `BaseAgentId` to `string`, `Exclude<BaseAgentId, "user">` evaluates to `string` (no longer narrows). This affects:
- `runtime.ts:13` — `RouteMessageInput.toAgentId: Exclude<BaseAgentId, "user">` → change to `string`
- `runtime.ts:44` — `ChatInput.toAgentId: Exclude<BaseAgentId, "user">` → change to `string`
- `apps/cli/index.ts:10` — `ChatTarget = Exclude<BaseAgentId, "user">` → change to `string`

Update these three usages to use `string` directly. The constraint that "user" cannot be a message target is now enforced at runtime (the `routeMessage` method already throws for unknown agents), not at the type level.

Expected: PASS after fixes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/contracts.ts packages/core/contracts.test.ts
git commit -m "feat: widen BaseAgentId, add Permission, ScheduledJob, new trace types"
```

---

### Task 2: ThreadStore — Job Persistence

**Files:**
- Modify: `packages/core/thread-store.ts`

- [ ] **Step 1: Write failing test for appendJob and getJobRecords**

Add to a new file `packages/core/thread-store-jobs.test.ts`:

```ts
import { test, expect, beforeEach } from "bun:test";
import { ThreadStore } from "./thread-store";
import type { ScheduledJob } from "./contracts";
import { rmSync } from "node:fs";

const TEST_DIR = ".runtime-data-test-jobs";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId: overrides.jobId ?? "job_1",
    sessionId: "s1",
    createdBy: "runtime",
    targetAgentId: "code",
    task: "health check",
    schedule: { type: "cron", cron: "*/5 * * * *" },
    status: "active",
    runCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

test("appendJob and getJobRecords round-trip", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  const job = makeJob();
  await store.appendJob(job);

  const records = await store.getJobRecords();
  expect(records.length).toBe(1);
  expect(records[0].jobId).toBe("job_1");
});

test("getJobRecords deduplicates by jobId (last wins)", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  await store.appendJob(makeJob({ status: "active", runCount: 0 }));
  await store.appendJob(makeJob({ status: "completed", runCount: 3 }));

  const records = await store.getJobRecords();
  expect(records.length).toBe(1);
  expect(records[0].status).toBe("completed");
  expect(records[0].runCount).toBe(3);
});

test("getJobRecords returns empty array when no file", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  const records = await store.getJobRecords();
  expect(records).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/thread-store-jobs.test.ts`
Expected: FAIL — `appendJob` and `getJobRecords` don't exist.

- [ ] **Step 3: Add appendJob and getJobRecords to ThreadStore**

In `packages/core/thread-store.ts`:

1. Add import for `ScheduledJob`.
2. Add `private readonly jobsFile: string;` initialized in constructor as `join(this.sessionDir, "jobs.jsonl")`.
3. Add methods:

```ts
async appendJob(job: ScheduledJob) {
    await this.appendJsonl(this.jobsFile, job);
}

async getJobRecords(): Promise<ScheduledJob[]> {
    const data = await this.readFile(this.jobsFile);
    const rows = parseJsonLines<ScheduledJob>(data);
    const byJobId = new Map<string, ScheduledJob>();
    for (const row of rows) {
        byJobId.set(row.jobId, row);
    }
    return [...byJobId.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/thread-store-jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tests**

Run: `bun test`
Expected: All tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add packages/core/thread-store.ts packages/core/thread-store-jobs.test.ts
git commit -m "feat: add appendJob/getJobRecords to ThreadStore for scheduler persistence"
```

---

### Task 3: ChatManager — HITL Timeout Pause/Resume

**Files:**
- Modify: `packages/core/chat-manager.ts`

- [ ] **Step 1: Write failing test for pauseTimeout/resumeTimeout**

Add to `packages/core/chat-manager.test.ts`:

```ts
test("pauseTimeout prevents chat timeout during HITL", async () => {
  // Use a very short timeout (50ms) so pause is meaningful
  const manager = new ChatManager();
  let hitlResolved = false;

  const chat = manager.createChat(
    { ...baseInput({ task: "hitl-test" }), timeoutMs: 50 },
    async (_ctx, chatRecord) => {
      // Pause timeout, then sleep 150ms (3x the timeout).
      // Without pause, the chat would timeout at 50ms.
      manager.pauseTimeout(chatRecord.chatId);
      await Bun.sleep(150);
      manager.resumeTimeout(chatRecord.chatId);
      hitlResolved = true;
      return "done";
    }
  );

  await waitUntil(() => manager.getChat(chat.chatId)?.status === "closed");
  expect(hitlResolved).toBe(true);
  expect(manager.getChat(chat.chatId)?.closeReason).toBe("completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/chat-manager.test.ts`
Expected: FAIL — `pauseTimeout` and `resumeTimeout` don't exist.

- [ ] **Step 3: Implement pauseTimeout and resumeTimeout**

In `packages/core/chat-manager.ts`, add to the `ChatRuntimeData` interface:

```ts
interface ChatRuntimeData {
    record: AgentChat;
    controller?: AbortController;
    runner?: ChatRunner;
    timeoutHandle?: ReturnType<typeof setTimeout>;
    timeoutRemainingMs?: number;
    timeoutPausedAt?: number;
}
```

Add public methods to `ChatManager`:

```ts
pauseTimeout(chatId: string): void {
    const runtime = this.chats.get(chatId);
    if (!runtime || !runtime.timeoutHandle) return;
    clearTimeout(runtime.timeoutHandle);
    runtime.timeoutHandle = undefined;
    runtime.timeoutPausedAt = Date.now();
    // Calculate remaining time
    const elapsed = Date.now() - (runtime.record.startedAt ?? Date.now());
    runtime.timeoutRemainingMs = Math.max(0, runtime.record.timeoutMs - elapsed);
}

resumeTimeout(chatId: string): void {
    const runtime = this.chats.get(chatId);
    if (!runtime || runtime.timeoutHandle || !runtime.timeoutPausedAt) return;
    const remaining = runtime.timeoutRemainingMs ?? runtime.record.timeoutMs;
    runtime.timeoutPausedAt = undefined;
    // Re-arm is handled by the execute loop — we just store the remaining time
    // The timeout promise in execute() checks timeoutRemainingMs
    runtime.timeoutRemainingMs = remaining;
}
```

Update the `execute()` method to integrate with pause/resume. The key change is in the timeout setup inside the `while` loop:

1. Store the `setTimeout` handle in `runtime.timeoutHandle` (instead of a local variable) so `pauseTimeout` can `clearTimeout` it.
2. When creating the timeout promise, use `runtime.timeoutRemainingMs ?? runtime.record.timeoutMs` as the delay, so resumed chats use remaining time.
3. In `pauseTimeout`: clear the timeout handle, record `timeoutPausedAt = Date.now()`, compute `timeoutRemainingMs = max(0, timeoutMs - elapsed)`.
4. In `resumeTimeout`: set a **new** `setTimeout` with `timeoutRemainingMs` that rejects the same promise. Store the new handle in `runtime.timeoutHandle`.

This way the existing `Promise.race([runner, timeoutPromise])` pattern in `execute()` continues to work — the timeout promise is just re-armed with the remaining duration after resume.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/chat-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/chat-manager.ts packages/core/chat-manager.test.ts
git commit -m "feat: add pauseTimeout/resumeTimeout to ChatManager for HITL interaction"
```

---

### Task 4: ToolRegistry

**Files:**
- Create: `packages/core/tool-registry.ts`
- Create: `packages/core/tool-registry.test.ts`

- [ ] **Step 1: Write failing tests for ToolRegistry**

Create `packages/core/tool-registry.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { ToolRegistry, type ToolEntry } from "./tool-registry";
import { Type } from "@sinclair/typebox";

function makeTool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    name: overrides.name ?? "test_tool",
    source: overrides.source ?? "local",
    description: overrides.description ?? "A test tool",
    parameters: overrides.parameters ?? Type.Object({}),
    execute: overrides.execute ?? (async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    })),
    defaultPermission: overrides.defaultPermission ?? "allow",
    available: overrides.available ?? true,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  test("register and get a local tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool({ name: "read_file" });
    registry.register(tool);

    const found = registry.get("read_file");
    expect(found).toBeDefined();
    expect(found!.name).toBe("read_file");
  });

  test("get returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("list returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    expect(registry.list().length).toBe(2);
  });

  test("resolve returns tools by exact name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    registry.register(makeTool({ name: "write_file" }));

    const resolved = registry.resolve(["read_file"]);
    expect(resolved.length).toBe(1);
    expect(resolved[0].name).toBe("read_file");
  });

  test("resolve supports glob pattern with *", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "mcp:filesystem/read" }));
    registry.register(makeTool({ name: "mcp:filesystem/write" }));
    registry.register(makeTool({ name: "mcp:git/status" }));

    const resolved = registry.resolve(["mcp:filesystem/*"]);
    expect(resolved.length).toBe(2);
    expect(resolved.map(t => t.name).sort()).toEqual([
      "mcp:filesystem/read",
      "mcp:filesystem/write",
    ]);
  });

  test("resolve skips unavailable tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "mcp:fs/read", available: false }));
    registry.register(makeTool({ name: "mcp:fs/write", available: true }));

    const resolved = registry.resolve(["mcp:fs/*"]);
    expect(resolved.length).toBe(1);
    expect(resolved[0].name).toBe("mcp:fs/write");
  });

  test("resolve deduplicates when multiple refs match same tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    const resolved = registry.resolve(["read_file", "read_file"]);
    expect(resolved.length).toBe(1);
  });

  test("register overwrites existing tool with same name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "x", description: "old" }));
    registry.register(makeTool({ name: "x", description: "new" }));

    expect(registry.get("x")!.description).toBe("new");
    expect(registry.list().length).toBe(1);
  });

  test("connectMcp registers tools and disconnectMcp removes them", async () => {
    const registry = new ToolRegistry();
    // Simulate MCP connection with mock connector
    await registry.connectMcp("fs", {
      discover: async () => [
        { name: "read", description: "Read file", inputSchema: {} },
        { name: "write", description: "Write file", inputSchema: {} },
      ],
      callTool: async (_name, _params) => "ok",
      disconnect: async () => {},
    });

    expect(registry.get("mcp:fs/read")).toBeDefined();
    expect(registry.get("mcp:fs/write")).toBeDefined();
    expect(registry.list().filter(t => t.source === "mcp").length).toBe(2);

    await registry.disconnectMcp("fs");
    expect(registry.get("mcp:fs/read")).toBeUndefined();
    expect(registry.get("mcp:fs/write")).toBeUndefined();
  });

  test("connectMcp throws on failure", async () => {
    const registry = new ToolRegistry();
    await expect(registry.connectMcp("bad", {
      discover: async () => { throw new Error("connection refused"); },
      callTool: async () => "",
      disconnect: async () => {},
    })).rejects.toThrow("connection refused");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/tool-registry.test.ts`
Expected: FAIL — module `./tool-registry` not found.

- [ ] **Step 3: Implement ToolRegistry**

Create `packages/core/tool-registry.ts`:

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { Permission } from "./contracts";

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;

export interface ToolEntry {
  name: string;
  source: "local" | "mcp";
  mcpServer?: string;
  description: string;
  parameters: TSchema;
  execute: ToolExecuteFn;
  defaultPermission: Permission;
  available: boolean;
}

/** Convert raw JSON Schema (from MCP) to a TypeBox TSchema via Type.Unsafe(). */
export function normalizeSchema(input: TSchema | Record<string, unknown>): TSchema {
  if ("$id" in input || (input as TSchema)[Symbol.for("typebox:schema")] !== undefined) {
    return input as TSchema;
  }
  return Type.Unsafe(input);
}

function matchesGlob(pattern: string, name: string): boolean {
  if (!pattern.endsWith("*")) return pattern === name;
  const prefix = pattern.slice(0, -1);
  return name.startsWith(prefix);
}

export interface McpConnector {
  discover: () => Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  callTool: (toolName: string, params: Record<string, unknown>) => Promise<string>;
  disconnect: () => Promise<void>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly mcpConnectors = new Map<string, McpConnector>();

  register(tool: ToolEntry): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  list(): ToolEntry[] {
    return [...this.tools.values()];
  }

  resolve(refs: string[]): AgentTool<any>[] {
    const seen = new Set<string>();
    const result: AgentTool<any>[] = [];

    for (const ref of refs) {
      if (ref.includes("*")) {
        for (const tool of this.tools.values()) {
          if (!tool.available) continue;
          if (matchesGlob(ref, tool.name) && !seen.has(tool.name)) {
            seen.add(tool.name);
            result.push(this.toAgentTool(tool));
          }
        }
      } else {
        const tool = this.tools.get(ref);
        if (tool && tool.available && !seen.has(tool.name)) {
          seen.add(tool.name);
          result.push(this.toAgentTool(tool));
        }
      }
    }

    return result;
  }

  markAvailable(name: string, available: boolean): void {
    const tool = this.tools.get(name);
    if (tool) tool.available = available;
  }

  /** Mark all tools from a given MCP server as available/unavailable. */
  markMcpAvailable(serverName: string, available: boolean): void {
    for (const tool of this.tools.values()) {
      if (tool.source === "mcp" && tool.mcpServer === serverName) {
        tool.available = available;
      }
    }
  }

  /** Remove all tools from a given MCP server. */
  removeMcpTools(serverName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.source === "mcp" && tool.mcpServer === serverName) {
        this.tools.delete(name);
      }
    }
  }

  /**
   * Connect to an MCP server, discover its tools, and register them.
   * The connector abstracts the actual transport (stdio/HTTP).
   * Throws immediately on first-connect failure (no auto-reconnect).
   */
  async connectMcp(serverName: string, connector: McpConnector): Promise<void> {
    const descriptors = await connector.discover();
    this.mcpConnectors.set(serverName, connector);
    for (const desc of descriptors) {
      const qualifiedName = `mcp:${serverName}/${desc.name}`;
      const parameters: TSchema = desc.inputSchema
        ? Type.Unsafe(desc.inputSchema)
        : Type.Object({});
      this.register({
        name: qualifiedName,
        source: "mcp",
        mcpServer: serverName,
        description: desc.description ?? `MCP tool: ${desc.name}`,
        parameters,
        execute: async (_toolCallId, params) => {
          const result = await connector.callTool(desc.name, params);
          return { content: [{ type: "text", text: result }] };
        },
        defaultPermission: "allow",
        available: true,
      });
    }
  }

  /** Disconnect an MCP server and remove all its tools. */
  async disconnectMcp(serverName: string): Promise<void> {
    const connector = this.mcpConnectors.get(serverName);
    if (connector) {
      await connector.disconnect();
      this.mcpConnectors.delete(serverName);
    }
    this.removeMcpTools(serverName);
  }

  private toAgentTool(entry: ToolEntry): AgentTool<any> {
    return {
      name: entry.name,
      label: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      execute: entry.execute,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/tool-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/tool-registry.ts packages/core/tool-registry.test.ts
git commit -m "feat: add ToolRegistry with glob resolution and MCP lifecycle helpers"
```

---

### Task 5: MCP Client

**Files:**
- Create: `packages/core/mcp-client.ts`
- Create: `packages/core/mcp-client.test.ts`

- [ ] **Step 1: Write failing tests for MCP client**

Create `packages/core/mcp-client.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  McpDisconnectedError,
  parseMcpToolName,
  type McpServerConfig,
} from "./mcp-client";

describe("McpDisconnectedError", () => {
  test("is an Error instance with correct name", () => {
    const err = new McpDisconnectedError("filesystem");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpDisconnectedError");
    expect(err.serverName).toBe("filesystem");
    expect(err.message).toContain("filesystem");
  });
});

describe("parseMcpToolName", () => {
  test("creates namespaced tool name", () => {
    expect(parseMcpToolName("filesystem", "read_file")).toBe("mcp:filesystem/read_file");
  });

  test("handles empty server name", () => {
    expect(parseMcpToolName("", "tool")).toBe("mcp:/tool");
  });
});

describe("McpServerConfig type", () => {
  test("stdio config has required fields", () => {
    const config: McpServerConfig = {
      name: "filesystem",
      transport: "stdio",
      command: "mcp-fs",
      args: ["."],
    };
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("mcp-fs");
  });

  test("http config has required fields", () => {
    const config: McpServerConfig = {
      name: "remote",
      transport: "http",
      url: "http://localhost:8080",
    };
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:8080");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/mcp-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement MCP client types and helpers**

Create `packages/core/mcp-client.ts`:

```ts
import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolEntry, ToolExecuteFn } from "./tool-registry";
import type { Permission } from "./contracts";

export class McpDisconnectedError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP server '${serverName}' is disconnected.`);
    this.name = "McpDisconnectedError";
    this.serverName = serverName;
  }
}

export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; transport: "http"; url: string; headers?: Record<string, string> };

export function parseMcpToolName(serverName: string, toolName: string): string {
  return `mcp:${serverName}/${toolName}`;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Convert MCP tool descriptors into ToolEntry objects. */
export function mcpToolsToEntries(
  serverName: string,
  tools: McpToolDescriptor[],
  callTool: (toolName: string, params: Record<string, unknown>) => Promise<string>,
  defaultPermission: Permission = "allow",
): ToolEntry[] {
  return tools.map((t) => {
    const qualifiedName = parseMcpToolName(serverName, t.name);
    const parameters: TSchema = t.inputSchema
      ? Type.Unsafe(t.inputSchema)
      : Type.Object({});

    const execute: ToolExecuteFn = async (_toolCallId, params) => {
      const result = await callTool(t.name, params);
      return { content: [{ type: "text", text: result }] };
    };

    return {
      name: qualifiedName,
      source: "mcp" as const,
      mcpServer: serverName,
      description: t.description ?? `MCP tool: ${t.name}`,
      parameters,
      execute,
      defaultPermission,
      available: true,
    };
  });
}

/**
 * Reconnect policy constants.
 * Actual MCP protocol handling (stdio spawn, HTTP connection, tools/list, tools/call)
 * will be implemented when integrating with a real MCP SDK.
 * This module provides the types, error classes, and conversion utilities.
 */
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const MAX_RECONNECT_ATTEMPTS = 5;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/mcp-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/mcp-client.ts packages/core/mcp-client.test.ts
git commit -m "feat: add MCP client types, McpDisconnectedError, tool conversion utilities"
```

> **Note (I6):** MCP reconnection behavior (exponential backoff, max attempts, re-discovery after reconnect) needs integration tests when the real MCP SDK is wired in. The `RECONNECT_DELAYS` and `MAX_RECONNECT_ATTEMPTS` constants are defined here; tests for the actual reconnect loop should be added in the MCP SDK integration task (future work). For now, `connectMcp`/`disconnectMcp` on `ToolRegistry` (Task 4) cover the connect/disconnect lifecycle.

---

### Task 6: Agent Builder

**Files:**
- Create: `packages/core/agent-builder.ts`
- Create: `packages/core/agent-builder.test.ts`

- [ ] **Step 1: Write failing tests for agent builder**

Create `packages/core/agent-builder.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { defineAgent, type AgentDefinition } from "./agent-builder";

describe("defineAgent builder", () => {
  test("builds minimal agent definition", () => {
    const def = defineAgent("code")
      .name("Code Specialist")
      .role("Creates code snippets.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You are a coding specialist.")
      .build();

    expect(def.id).toBe("code");
    expect(def.name).toBe("Code Specialist");
    expect(def.role).toBe("Creates code snippets.");
    expect(def.modelConfig.provider).toBe("openrouter");
    expect(def.modelConfig.modelId).toBe("google/gemini-3.1-flash-lite-preview");
    expect(def.systemPrompt).toBe("You are a coding specialist.");
    expect(def.maxConcurrency).toBe(1); // default
  });

  test("builds agent with all options", () => {
    const def = defineAgent("code")
      .name("Code Specialist")
      .role("Creates code.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You are a coder.")
      .rules(["Always read before modifying.", "Be concise."])
      .examples([{ user: "Fix it", assistant: "Let me read first..." }])
      .tools(["read_file", "write_file"])
      .mcpTools(["mcp:filesystem/*"])
      .canDelegateTo(["math"], { maxDepth: 2 })
      .permissions({ "write_file": "hitl", "read_file": "allow" })
      .maxConcurrency(3)
      .build();

    expect(def.rules).toEqual(["Always read before modifying.", "Be concise."]);
    expect(def.examples).toHaveLength(1);
    expect(def.toolRefs).toEqual(["read_file", "write_file", "mcp:filesystem/*"]);
    expect(def.delegationRules).toEqual({ targets: ["math"], maxDepth: 2 });
    expect(def.permissions).toEqual({ "write_file": "hitl", "read_file": "allow" });
    expect(def.maxConcurrency).toBe(3);
  });

  test("build() throws if id is empty", () => {
    expect(() => defineAgent("").build()).toThrow("id");
  });

  test("build() throws if model is not set", () => {
    expect(() =>
      defineAgent("test")
        .name("Test")
        .role("Test role")
        .build()
    ).toThrow("model");
  });

  test("build() throws if neither systemPrompt nor role is set", () => {
    expect(() =>
      defineAgent("test")
        .name("Test")
        .model("openrouter", "x")
        .build()
    ).toThrow();
  });

  test("createAgent produces an Agent-compatible factory", () => {
    const def = defineAgent("code")
      .name("Code")
      .role("Code specialist.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You code.")
      .build();

    expect(typeof def.createAgent).toBe("function");
    // createAgent is a closure — we verify it's callable
    // Actual Agent creation needs the model, tested in integration
  });

  test("capabilities default to empty array", () => {
    const def = defineAgent("test")
      .name("Test")
      .role("Test.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .build();

    expect(def.capabilities).toEqual([]);
  });

  test("capabilities can be set", () => {
    const def = defineAgent("test")
      .name("Test")
      .role("Test.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .capabilities(["a", "b"])
      .build();

    expect(def.capabilities).toEqual(["a", "b"]);
  });

  test("schedule sets scheduleConfig on definition", () => {
    const def = defineAgent("cron-agent")
      .name("Cron Agent")
      .role("Runs on schedule.")
      .model("openrouter", "x")
      .systemPrompt("You run periodically.")
      .schedule({ type: "cron", cron: "*/5 * * * *" }, "health check")
      .build();

    expect(def.scheduleConfig).toEqual({
      schedule: { type: "cron", cron: "*/5 * * * *" },
      task: "health check",
    });
  });

  test("scheduleConfig defaults to undefined", () => {
    const def = defineAgent("no-sched")
      .name("No Schedule")
      .role("No schedule.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .build();

    expect(def.scheduleConfig).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/agent-builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement agent builder**

Create `packages/core/agent-builder.ts`:

```ts
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { errorMessage } from "./errors";
import type { Permission, ScheduledJob } from "./contracts";
import type { ToolEntry } from "./tool-registry";

export interface AgentModelConfig {
  provider: string;
  modelId: string;
}

export interface AgentHooks {
  beforeTool?: (toolName: string, params: Record<string, unknown>, ctx: { agentId: string }) => Promise<Record<string, unknown>>;
  afterTool?: (toolName: string, result: unknown, ctx: { agentId: string }) => Promise<unknown>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  modelConfig: AgentModelConfig;
  systemPrompt: string;
  rules: string[];
  examples: Array<{ user: string; assistant: string }>;
  toolRefs: string[];
  localTools?: ToolEntry[];
  delegationRules: { targets: string[]; maxDepth: number } | null;
  permissions: Record<string, Permission>;
  hooks: AgentHooks;
  maxConcurrency: number;
  scheduleConfig?: { schedule: ScheduledJob["schedule"]; task: string };
  createAgent: (resolvedTools: AgentTool<any>[], compiledPrompt: string) => Agent;
}

const _modelCache = new Map<string, ReturnType<typeof getModel>>();

function getModelCached(provider: string, modelId: string) {
  const key = `${provider}/${modelId}`;
  let model = _modelCache.get(key);
  if (model) return model;
  try {
    model = getModel(provider as any, modelId as any);
  } catch (err) {
    throw new Error(`Model init failed (${provider}/${modelId}): ${errorMessage(err)}`);
  }
  _modelCache.set(key, model);
  return model;
}

class AgentBuilder {
  private _id: string;
  private _name = "";
  private _role = "";
  private _capabilities: string[] = [];
  private _modelConfig?: AgentModelConfig;
  private _systemPrompt = "";
  private _rules: string[] = [];
  private _examples: Array<{ user: string; assistant: string }> = [];
  private _toolRefs: string[] = [];
  private _mcpToolRefs: string[] = [];
  private _localTools?: ToolEntry[];
  private _delegationRules: { targets: string[]; maxDepth: number } | null = null;
  private _permissions: Record<string, Permission> = {};
  private _hooks: AgentHooks = {};
  private _maxConcurrency = 1;
  private _scheduleConfig?: { schedule: ScheduledJob["schedule"]; task: string };

  constructor(id: string) {
    this._id = id;
  }

  name(n: string) { this._name = n; return this; }
  role(r: string) { this._role = r; return this; }
  capabilities(c: string[]) { this._capabilities = c; return this; }
  model(provider: string, modelId: string) { this._modelConfig = { provider, modelId }; return this; }
  systemPrompt(p: string) { this._systemPrompt = p; return this; }
  rules(r: string[]) { this._rules = r; return this; }
  examples(e: Array<{ user: string; assistant: string }>) { this._examples = e; return this; }
  tools(refs: string[]) { this._toolRefs = refs; return this; }
  mcpTools(refs: string[]) { this._mcpToolRefs = refs; return this; }
  localToolEntries(t: ToolEntry[]) { this._localTools = t; return this; }
  canDelegateTo(targets: string[], opts: { maxDepth: number } = { maxDepth: 2 }) {
    this._delegationRules = { targets, maxDepth: opts.maxDepth };
    return this;
  }
  permissions(p: Record<string, Permission>) { this._permissions = p; return this; }
  hooks(h: AgentHooks) { this._hooks = h; return this; }
  maxConcurrency(n: number) { this._maxConcurrency = n; return this; }
  schedule(sched: ScheduledJob["schedule"], task: string) { this._scheduleConfig = { schedule: sched, task }; return this; }

  build(): AgentDefinition {
    if (!this._id) throw new Error("Agent id is required.");
    if (!this._modelConfig) throw new Error("Agent model is required. Call .model(provider, modelId).");
    if (!this._systemPrompt && !this._role) {
      throw new Error("Agent requires at least a systemPrompt or role.");
    }

    const capturedModel = getModelCached(this._modelConfig.provider, this._modelConfig.modelId);

    return {
      id: this._id,
      name: this._name || this._id,
      role: this._role,
      capabilities: this._capabilities,
      modelConfig: this._modelConfig,
      systemPrompt: this._systemPrompt || `You are a ${this._role}`,
      rules: this._rules,
      examples: this._examples,
      toolRefs: [...this._toolRefs, ...this._mcpToolRefs],
      localTools: this._localTools,
      delegationRules: this._delegationRules,
      permissions: this._permissions,
      hooks: this._hooks,
      maxConcurrency: this._maxConcurrency,
      scheduleConfig: this._scheduleConfig,
      createAgent: (resolvedTools: AgentTool<any>[], compiledPrompt: string) => {
        return new Agent({
          initialState: {
            systemPrompt: compiledPrompt,
            model: capturedModel,
            tools: resolvedTools,
            messages: [],
          },
        });
      },
    };
  }
}

export function defineAgent(id: string): AgentBuilder {
  return new AgentBuilder(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/agent-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/agent-builder.ts packages/core/agent-builder.test.ts
git commit -m "feat: add defineAgent() builder producing AgentDefinition with closure-captured model"
```

---

### Task 7: Prompt Compiler

**Files:**
- Create: `packages/core/prompt-compiler.ts`
- Create: `packages/core/prompt-compiler.test.ts`

- [ ] **Step 1: Write failing tests for prompt compiler**

Create `packages/core/prompt-compiler.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { compileSystemPrompt } from "./prompt-compiler";
import type { AgentDefinition } from "./agent-builder";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

function minimalDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "test",
    name: "Test",
    role: "Test agent.",
    capabilities: [],
    modelConfig: { provider: "openrouter", modelId: "x" },
    systemPrompt: "You are a test agent.",
    rules: [],
    examples: [],
    toolRefs: [],
    delegationRules: null,
    permissions: {},
    hooks: {},
    maxConcurrency: 1,
    createAgent: () => null as any,
    ...overrides,
  };
}

function fakeTool(name: string, description: string): AgentTool<any> {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("compileSystemPrompt", () => {
  test("includes base system prompt", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).toContain("You are a test agent.");
  });

  test("includes tool descriptions", () => {
    const tools = [fakeTool("read_file", "Reads a file from disk.")];
    const result = compileSystemPrompt(minimalDef(), tools);
    expect(result).toContain("read_file");
    expect(result).toContain("Reads a file from disk.");
  });

  test("includes rules as bulleted list", () => {
    const def = minimalDef({ rules: ["Be concise.", "Always verify."] });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("- Be concise.");
    expect(result).toContain("- Always verify.");
  });

  test("includes examples as user/assistant pairs", () => {
    const def = minimalDef({
      examples: [{ user: "Fix the bug", assistant: "Let me read the file first." }],
    });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("User: Fix the bug");
    expect(result).toContain("Assistant: Let me read the file first.");
  });

  test("includes delegation info when canDelegateTo is set", () => {
    const def = minimalDef({
      delegationRules: { targets: ["math", "search"], maxDepth: 2 },
    });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("math");
    expect(result).toContain("search");
    expect(result).toContain("delegate");
  });

  test("omits delegation section when delegationRules is null", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).not.toContain("Delegation");
  });

  test("caps tool descriptions at ~4000 chars", () => {
    const longDesc = "A".repeat(500);
    const tools = Array.from({ length: 20 }, (_, i) =>
      fakeTool(`tool_${i}`, longDesc)
    );
    const result = compileSystemPrompt(minimalDef(), tools);
    // The tool section should be capped
    const toolSection = result.split("## Rules")[0] ?? result;
    // Should be reasonable length, not 10000+ chars
    expect(toolSection.length).toBeLessThan(5000);
  });

  test("returns string without empty sections", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).not.toContain("## Rules");
    expect(result).not.toContain("## Examples");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/prompt-compiler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement prompt compiler**

Create `packages/core/prompt-compiler.ts`:

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentDefinition } from "./agent-builder";

const MAX_TOOL_SECTION_CHARS = 4000;

function compileToolSection(tools: AgentTool<any>[]): string {
  if (tools.length === 0) return "";

  const lines: string[] = ["## Available Tools", ""];
  let totalChars = 0;

  for (const tool of tools) {
    const line = `- **${tool.name}**: ${tool.description}`;
    if (totalChars + line.length > MAX_TOOL_SECTION_CHARS) {
      lines.push(`- ... and ${tools.length - lines.length + 2} more tools.`);
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }

  return lines.join("\n");
}

function compileDelegationSection(rules: { targets: string[]; maxDepth: number }): string {
  const targetList = rules.targets.join(", ");
  return [
    "## Delegation",
    "",
    `You can delegate tasks to these specialists: ${targetList}.`,
    `Use the delegate tool. Max delegation depth: ${rules.maxDepth}.`,
  ].join("\n");
}

function compileRulesSection(rules: string[]): string {
  if (rules.length === 0) return "";
  return ["## Rules", "", ...rules.map((r) => `- ${r}`)].join("\n");
}

function compileExamplesSection(examples: Array<{ user: string; assistant: string }>): string {
  if (examples.length === 0) return "";
  const parts = examples.map(
    (e) => `User: ${e.user}\nAssistant: ${e.assistant}`
  );
  return ["## Examples", "", parts.join("\n---\n")].join("\n");
}

export function compileSystemPrompt(
  def: AgentDefinition,
  resolvedTools: AgentTool<any>[],
): string {
  const sections: string[] = [def.systemPrompt];

  const toolSection = compileToolSection(resolvedTools);
  if (toolSection) sections.push(toolSection);

  if (def.delegationRules) {
    sections.push(compileDelegationSection(def.delegationRules));
  }

  const rulesSection = compileRulesSection(def.rules);
  if (rulesSection) sections.push(rulesSection);

  const examplesSection = compileExamplesSection(def.examples);
  if (examplesSection) sections.push(examplesSection);

  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/prompt-compiler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/prompt-compiler.ts packages/core/prompt-compiler.test.ts
git commit -m "feat: add compileSystemPrompt with 5-layer prompt assembly and tool cap"
```

---

### Task 8: Tool Middleware (wrapTool)

**Files:**
- Create: `packages/core/tool-middleware.ts`
- Create: `packages/core/tool-middleware.test.ts`

- [ ] **Step 1: Write failing tests for wrapTool**

Create `packages/core/tool-middleware.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { wrapTool, type HITLHandler, type HITLRequest } from "./tool-middleware";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Permission } from "./contracts";

function fakeTool(name = "test_tool"): AgentTool<any> {
  return {
    name,
    label: name,
    description: "test",
    parameters: Type.Object({ input: Type.String() }),
    execute: async (_id: string, params: any) => ({
      content: [{ type: "text" as const, text: `result:${params.input}` }],
    }),
  };
}

const approveAll: HITLHandler = async () => ({ approved: true });
const denyAll: HITLHandler = async () => ({ approved: false });
const noopTrace = async () => {};

describe("wrapTool", () => {
  test("allow permission passes through to original execute", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("result:hello");
  });

  test("deny permission blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "deny",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toContain("denied");
  });

  test("hitl permission with approval passes through", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("result:hello");
  });

  test("hitl permission with denial blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toContain("denied");
  });

  test("hitl with modifiedParams uses new params", async () => {
    const handler: HITLHandler = async () => ({
      approved: true,
      modifiedParams: { input: "modified" },
    });

    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: handler,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "original" });
    expect(result.content[0].text).toBe("result:modified");
  });

  test("beforeTool hook can transform params", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
      hooks: {
        beforeTool: async (_name, params) => ({ ...params, input: "hooked" }),
      },
    });

    const result = await wrapped.execute("tc1", { input: "original" });
    expect(result.content[0].text).toBe("result:hooked");
  });

  test("afterTool hook can transform result", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
      hooks: {
        afterTool: async (_name, result) => ({
          content: [{ type: "text", text: "after-hooked" }],
        }),
      },
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("after-hooked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/tool-middleware.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement wrapTool**

Create `packages/core/tool-middleware.ts`:

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Permission } from "./contracts";
import type { AgentHooks } from "./agent-builder";

export interface HITLRequest {
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  reason: string;
  timeout: number;
}

export interface HITLResponse {
  approved: boolean;
  modifiedParams?: Record<string, unknown>;
}

export type HITLHandler = (request: HITLRequest) => Promise<HITLResponse>;

export interface WrapToolOptions {
  permission: Permission;
  hitlHandler: HITLHandler;
  hooks?: AgentHooks;
  agentId: string;
  hitlTimeout?: number;
  tracePermission: (info: { toolName: string; permission: Permission; resolved: string }) => Promise<void>;
}

export function resolvePermission(
  runtimeOverride: Permission | undefined,
  agentPermissions: Record<string, Permission>,
  toolName: string,
  defaultPermission: Permission,
): Permission {
  if (runtimeOverride) return runtimeOverride;

  // Check exact match first
  if (agentPermissions[toolName]) return agentPermissions[toolName];

  // Check glob patterns in agent permissions
  for (const [pattern, perm] of Object.entries(agentPermissions)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (toolName.startsWith(prefix)) return perm;
    }
  }

  return defaultPermission || "deny";
}

export function wrapTool(
  tool: AgentTool<any>,
  options: WrapToolOptions,
): AgentTool<any> {
  const { permission, hitlHandler, hooks, agentId, hitlTimeout = 60_000, tracePermission } = options;

  return {
    ...tool,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      // 1. Permission check
      await tracePermission({ toolName: tool.name, permission, resolved: permission });

      if (permission === "deny") {
        return {
          content: [{ type: "text", text: `Tool '${tool.name}' is denied for agent '${agentId}'.` }],
        };
      }

      let finalParams = params;

      // 2. HITL prompt if needed
      if (permission === "hitl") {
        const request: HITLRequest = {
          agentId,
          toolName: tool.name,
          params,
          reason: `Agent '${agentId}' wants to use '${tool.name}'.`,
          timeout: hitlTimeout,
        };

        let response: HITLResponse;
        try {
          response = await Promise.race([
            hitlHandler(request),
            new Promise<HITLResponse>((_, reject) =>
              setTimeout(() => reject(new Error("HITL_TIMEOUT")), hitlTimeout)
            ),
          ]);
        } catch (err) {
          if (err instanceof Error && err.message === "HITL_TIMEOUT") {
            return {
              content: [{ type: "text", text: `Approval timed out, tool '${tool.name}' denied.` }],
            };
          }
          throw err;
        }

        if (!response.approved) {
          return {
            content: [{ type: "text", text: `Tool '${tool.name}' denied by human.` }],
          };
        }

        if (response.modifiedParams) {
          finalParams = response.modifiedParams;
        }
      }

      // 3. beforeTool hook
      if (hooks?.beforeTool) {
        finalParams = await hooks.beforeTool(tool.name, finalParams, { agentId });
      }

      // 4. Execute
      let result = await tool.execute(toolCallId, finalParams);

      // 5. afterTool hook
      if (hooks?.afterTool) {
        result = await hooks.afterTool(tool.name, result, { agentId }) as typeof result;
      }

      return result;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/tool-middleware.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/tool-middleware.ts packages/core/tool-middleware.test.ts
git commit -m "feat: add wrapTool middleware with permission, HITL, and hooks pipeline"
```

---

### Task 9: Scheduler — Cron Parser

**Files:**
- Create: `packages/core/scheduler.ts`
- Create: `packages/core/scheduler.test.ts`

- [ ] **Step 1: Write failing tests for cron parser**

Create `packages/core/scheduler.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { nextCronTick, parseCronField } from "./scheduler";

describe("parseCronField", () => {
  test("* matches all values in range", () => {
    const values = parseCronField("*", 0, 59);
    expect(values).toHaveLength(60);
  });

  test("specific number", () => {
    expect(parseCronField("5", 0, 59)).toEqual([5]);
  });

  test("range 1-5", () => {
    expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  test("step */5 in 0-59", () => {
    const values = parseCronField("*/5", 0, 59);
    expect(values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  test("list 1,3,5", () => {
    expect(parseCronField("1,3,5", 0, 59)).toEqual([1, 3, 5]);
  });

  test("step with range 10-20/3", () => {
    expect(parseCronField("10-20/3", 0, 59)).toEqual([10, 13, 16, 19]);
  });
});

describe("nextCronTick", () => {
  test("every minute from known time", () => {
    // 2026-03-17 10:30:00 UTC
    const from = new Date("2026-03-17T10:30:00Z");
    const next = nextCronTick("* * * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T10:31:00Z").getTime());
  });

  test("every 5 minutes", () => {
    const from = new Date("2026-03-17T10:32:00Z");
    const next = nextCronTick("*/5 * * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T10:35:00Z").getTime());
  });

  test("specific hour and minute", () => {
    const from = new Date("2026-03-17T08:00:00Z");
    const next = nextCronTick("30 9 * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T09:30:00Z").getTime());
  });

  test("wraps to next day", () => {
    const from = new Date("2026-03-17T23:59:00Z");
    const next = nextCronTick("0 0 * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-18T00:00:00Z").getTime());
  });

  test("specific day of week (Monday=1)", () => {
    // 2026-03-17 is a Tuesday (day 2)
    const from = new Date("2026-03-17T12:00:00Z");
    const next = nextCronTick("0 9 * * 1", from); // Monday 9:00
    // Next Monday is 2026-03-23
    expect(next.getTime()).toBe(new Date("2026-03-23T09:00:00Z").getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cron parser**

In `packages/core/scheduler.ts` (first part — cron parsing):

```ts
import type { ScheduledJob } from "./contracts";
import { createId, now } from "./ids";
import { errorMessage } from "./errors";

/** Parse a single cron field (e.g., "*/5", "1-5", "1,3,5") into an array of matching values. */
export function parseCronField(field: string, min: number, max: number): number[] {
  const results: number[] = [];

  for (const part of field.split(",")) {
    let stepStr: string | undefined;
    let rangeStr = part;

    if (part.includes("/")) {
      [rangeStr, stepStr] = part.split("/");
    }

    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let start = min;
    let end = max;

    if (rangeStr === "*") {
      // default range
    } else if (rangeStr.includes("-")) {
      const [s, e] = rangeStr.split("-");
      start = parseInt(s, 10);
      end = parseInt(e, 10);
    } else {
      const val = parseInt(rangeStr, 10);
      if (!stepStr) {
        results.push(val);
        continue;
      }
      start = val;
    }

    for (let i = start; i <= end; i += step) {
      results.push(i);
    }
  }

  return results.sort((a, b) => a - b);
}

/** Compute the next occurrence after `from` for a 5-field cron pattern. */
export function nextCronTick(pattern: string, from: Date): Date {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron pattern: expected 5 fields, got ${fields.length}`);

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6);

  const hasDowConstraint = fields[4] !== "*";
  const hasDomConstraint = fields[2] !== "*";

  // Start searching from 1 minute after `from`
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Safety: max 366 days of scanning
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getUTCMonth() + 1;
    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    const hour = candidate.getUTCHours();
    const minute = candidate.getUTCMinutes();

    if (!months.includes(month)) {
      // Jump to next valid month
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dayMatch = hasDowConstraint && hasDomConstraint
      ? daysOfMonth.includes(dom) || daysOfWeek.includes(dow)
      : hasDowConstraint
        ? daysOfWeek.includes(dow)
        : hasDomConstraint
          ? daysOfMonth.includes(dom)
          : true;

    if (!dayMatch) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!hours.includes(hour)) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minutes.includes(minute)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(candidate.getTime());
  }

  throw new Error(`Could not find next cron tick for '${pattern}' within 366 days.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/scheduler.ts packages/core/scheduler.test.ts
git commit -m "feat: add 5-field cron parser with nextCronTick"
```

---

### Task 10: Scheduler — Job Lifecycle

**Files:**
- Modify: `packages/core/scheduler.ts`
- Add to: `packages/core/scheduler.test.ts`

- [ ] **Step 1: Write failing tests for Scheduler class**

Append to `packages/core/scheduler.test.ts`:

```ts
import { Scheduler, type CreateJobInput } from "./scheduler";

function noopTrace() { return Promise.resolve(); }

function makeScheduler(overrides: {
  persistJob?: (job: ScheduledJob) => Promise<void>;
  restoreJobs?: () => Promise<ScheduledJob[]>;
  executeTask?: (agentId: string, task: string) => Promise<string>;
} = {}) {
  return new Scheduler({
    persistJob: overrides.persistJob ?? (async () => {}),
    restoreJobs: overrides.restoreJobs ?? (async () => []),
    executeTask: overrides.executeTask ?? (async () => "done"),
    trace: noopTrace as any,
  });
}

describe("Scheduler", () => {
  test("addJob creates a job with active status", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1",
      createdBy: "runtime",
      targetAgentId: "code",
      task: "health check",
      schedule: { type: "cron", cron: "*/5 * * * *" },
    });

    expect(job.status).toBe("active");
    expect(job.schedule.type).toBe("cron");
    expect(job.runCount).toBe(0);
    scheduler.shutdown();
  });

  test("addJob with delay type computes runAt", () => {
    const scheduler = makeScheduler();
    const before = Date.now();
    const job = scheduler.addJob({
      sessionId: "s1",
      createdBy: "orchestrator",
      targetAgentId: "math",
      task: "compute",
      schedule: { type: "delay", delayMs: 5000 },
    });

    expect(job.nextRunAt).toBeGreaterThanOrEqual(before + 5000);
    expect(job.maxRuns).toBe(1);
    scheduler.shutdown();
  });

  test("listJobs returns all jobs", () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "a",
      schedule: { type: "cron", cron: "* * * * *" },
    });
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "math", task: "b",
      schedule: { type: "once", runAt: Date.now() + 60000 },
    });

    expect(scheduler.listJobs().length).toBe(2);
    scheduler.shutdown();
  });

  test("removeJob returns true for existing job", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "once", runAt: Date.now() + 60000 },
    });

    expect(scheduler.removeJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)).toBeUndefined();
    scheduler.shutdown();
  });

  test("removeJob returns false for unknown job", () => {
    const scheduler = makeScheduler();
    expect(scheduler.removeJob("nope")).toBe(false);
    scheduler.shutdown();
  });

  test("pauseJob and resumeJob toggle status", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "*/5 * * * *" },
    });

    expect(scheduler.pauseJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)?.status).toBe("paused");

    expect(scheduler.resumeJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)?.status).toBe("active");
    scheduler.shutdown();
  });

  test("shutdown clears all timers", () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "* * * * *" },
    });
    // Should not throw
    scheduler.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/scheduler.test.ts`
Expected: FAIL — `Scheduler` class not found.

- [ ] **Step 3: Implement Scheduler class**

Append to `packages/core/scheduler.ts`:

```ts
export interface CreateJobInput {
  sessionId: string;
  createdBy: string;
  targetAgentId: string;
  task: string;
  schedule: ScheduledJob["schedule"];
  maxRuns?: number;
}

interface SchedulerOptions {
  persistJob: (job: ScheduledJob) => Promise<void>;
  restoreJobs: () => Promise<ScheduledJob[]>;
  executeTask: (agentId: string, task: string) => Promise<string>;
  trace: (event: { type: string; status: string; runId: string; turnId: string; details?: Record<string, unknown> }) => Promise<void>;
}

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly opts: SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  addJob(input: CreateJobInput): ScheduledJob {
    const jobId = createId("job");
    const timestamp = now();

    let nextRunAt: number | undefined;
    let maxRuns = input.maxRuns;

    switch (input.schedule.type) {
      case "cron": {
        const next = nextCronTick(input.schedule.cron!, new Date(timestamp));
        nextRunAt = next.getTime();
        break;
      }
      case "once": {
        nextRunAt = input.schedule.runAt!;
        maxRuns = maxRuns ?? 1;
        break;
      }
      case "delay": {
        nextRunAt = timestamp + input.schedule.delayMs!;
        maxRuns = maxRuns ?? 1;
        break;
      }
    }

    const job: ScheduledJob = {
      jobId,
      sessionId: input.sessionId,
      createdBy: input.createdBy,
      targetAgentId: input.targetAgentId,
      task: input.task,
      schedule: input.schedule,
      status: "active",
      nextRunAt,
      runCount: 0,
      maxRuns,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.jobs.set(jobId, job);
    void this.opts.persistJob(job);
    this.armTimer(job);

    return { ...job };
  }

  removeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    this.clearTimer(jobId);
    this.jobs.delete(jobId);
    return true;
  }

  pauseJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "active") return false;

    job.status = "paused";
    job.updatedAt = now();
    this.clearTimer(jobId);
    void this.opts.persistJob(job);
    return true;
  }

  resumeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "paused") return false;

    job.status = "active";
    job.updatedAt = now();

    // Recompute nextRunAt
    if (job.schedule.type === "cron") {
      const next = nextCronTick(job.schedule.cron!, new Date());
      job.nextRunAt = next.getTime();
    }

    void this.opts.persistJob(job);
    this.armTimer(job);
    return true;
  }

  listJobs(): ScheduledJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  getJob(jobId: string): ScheduledJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  async restore(): Promise<number> {
    const records = await this.opts.restoreJobs();
    let count = 0;
    for (const record of records) {
      if (record.status !== "active" && record.status !== "paused") continue;
      this.jobs.set(record.jobId, record);
      if (record.status === "active") {
        // Recompute nextRunAt and arm
        if (record.schedule.type === "cron") {
          record.nextRunAt = nextCronTick(record.schedule.cron!, new Date()).getTime();
        } else if (record.nextRunAt && record.nextRunAt <= now()) {
          // Past due — execute immediately
          record.nextRunAt = now();
        }
        this.armTimer(record);
      }
      count++;
    }
    return count;
  }

  shutdown(): void {
    for (const [jobId] of this.timers) {
      this.clearTimer(jobId);
    }
  }

  private armTimer(job: ScheduledJob): void {
    if (!job.nextRunAt) return;
    const delayMs = Math.max(0, job.nextRunAt - now());

    const handle = setTimeout(() => {
      void this.executeJob(job.jobId);
    }, delayMs);

    this.timers.set(job.jobId, handle);
  }

  private clearTimer(jobId: string): void {
    const handle = this.timers.get(jobId);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(jobId);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "active") return;

    const runId = createId("run");
    const turnId = createId("turn");

    await this.opts.trace({
      type: "job_triggered",
      status: "running",
      runId,
      turnId,
      details: { jobId, targetAgentId: job.targetAgentId, task: job.task },
    });

    try {
      const result = await this.opts.executeTask(job.targetAgentId, job.task);

      job.runCount += 1;
      job.lastRunAt = now();
      job.updatedAt = now();

      await this.opts.trace({
        type: "job_completed",
        status: "completed",
        runId,
        turnId,
        details: { jobId, result: result.slice(0, 200) },
      });

      // Check if done
      if (job.maxRuns && job.runCount >= job.maxRuns) {
        job.status = "completed";
        job.nextRunAt = undefined;
        this.clearTimer(jobId);
      } else if (job.schedule.type === "cron") {
        // Re-arm for next occurrence
        job.nextRunAt = nextCronTick(job.schedule.cron!, new Date()).getTime();
        this.armTimer(job);
      }

      void this.opts.persistJob(job);
    } catch (err) {
      job.error = errorMessage(err);
      job.status = "failed";
      job.updatedAt = now();
      this.clearTimer(jobId);
      void this.opts.persistJob(job);

      await this.opts.trace({
        type: "job_failed",
        status: "error",
        runId,
        turnId,
        details: { jobId, error: job.error },
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/scheduler.ts packages/core/scheduler.test.ts
git commit -m "feat: add Scheduler class with job lifecycle, timer management, and persistence"
```

---

### Task 11: Rewrite agents.ts with defineAgent

**Files:**
- Modify: `packages/core/agents.ts`

- [ ] **Step 1: Write test for new agent definitions**

Create `packages/core/agents-v2.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { createAgentDefinitions, ORCHESTRATOR_ID } from "./agents";
import type { AgentDefinition } from "./agent-builder";

describe("Agent definitions v2", () => {
  test("createAgentDefinitions returns orchestrator, code, and math", () => {
    const defs = createAgentDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain(ORCHESTRATOR_ID);
    expect(ids).toContain("code");
    expect(ids).toContain("math");
  });

  test("each definition has required fields", () => {
    const defs = createAgentDefinitions();
    for (const def of defs) {
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.modelConfig.provider).toBeTruthy();
      expect(def.modelConfig.modelId).toBeTruthy();
      expect(def.systemPrompt).toBeTruthy();
      expect(typeof def.createAgent).toBe("function");
    }
  });

  test("orchestrator has delegation-related tool refs", () => {
    const defs = createAgentDefinitions();
    const orch = defs.find((d) => d.id === ORCHESTRATOR_ID)!;
    // Orchestrator's built-in tools are registered separately by the runtime
    // But it should have an empty or specific toolRefs
    expect(orch.toolRefs).toBeDefined();
  });

  test("math specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const math = defs.find((d) => d.id === "math")!;
    expect(math.maxConcurrency).toBe(1);
  });

  test("code specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const code = defs.find((d) => d.id === "code")!;
    expect(code.maxConcurrency).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/agents-v2.test.ts`
Expected: FAIL — `createAgentDefinitions` not found.

- [ ] **Step 3: Rewrite agents.ts**

Replace `packages/core/agents.ts` with:

```ts
import { defineAgent, type AgentDefinition } from "./agent-builder";

export const ORCHESTRATOR_ID = "orchestrator" as const;

export function createAgentDefinitions(): AgentDefinition[] {
  const orchestrator = defineAgent(ORCHESTRATOR_ID)
    .name("Orchestrator")
    .role("Routes and delegates tasks to specialists.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are an orchestrator agent.",
      "Use list_agents to discover available specialists.",
      "Use delegate to send tasks to specialists.",
      "Then poll with get_chat_status/get_chat_result to get results.",
      "After tool results, produce a direct final answer for the user.",
      "Be concise by default.",
    ].join(" "))
    .capabilities(["routing", "delegation"])
    .tools([])
    .maxConcurrency(Infinity)
    .build();

  const code = defineAgent("code")
    .name("Code Specialist")
    .role("Creates focused code snippets.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a coding specialist. Return concise, practical answers. Prefer short code snippets and include only essential explanation."
    )
    .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
    .maxConcurrency(1)
    .build();

  const math = defineAgent("math")
    .name("Math Specialist")
    .role("Solves arithmetic operations.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a math specialist. Solve arithmetic tasks clearly and accurately. Return the final numeric result in one short sentence. Show steps only if the user asks."
    )
    .capabilities(["add", "subtract", "multiply", "divide"])
    .maxConcurrency(1)
    .build();

  return [orchestrator, code, math];
}
```

Keep `ORCHESTRATOR_ID` export unchanged for backward compatibility. **Do NOT remove** the old exports yet — add deprecated wrappers so `runtime.ts` and tests continue to compile until Task 13 migrates them:

```ts
// Deprecated — kept for backward compatibility until runtime migration (Task 13)
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { SpecialistRegistry } from "./tools";

/** @deprecated Use createAgentDefinitions() instead. */
export function createSpecialistRegistry(): SpecialistRegistry {
  const defs = createAgentDefinitions();
  const registry: SpecialistRegistry = {};
  for (const def of defs) {
    if (def.id === ORCHESTRATOR_ID) continue;
    registry[def.id] = {
      id: def.id,
      name: def.name,
      role: def.role,
      capabilities: def.capabilities,
      maxConcurrency: def.maxConcurrency,
      createAgent: () => def.createAgent([], def.systemPrompt),
    };
  }
  return registry;
}

/** @deprecated Use createAgentDefinitions() instead. */
export function createOrchestratorAgent(tools: AgentTool<any>[] = []) {
  const defs = createAgentDefinitions();
  const orch = defs.find(d => d.id === ORCHESTRATOR_ID)!;
  return orch.createAgent(tools, orch.systemPrompt);
}
```

These wrappers will be removed in Task 13 when the runtime is fully migrated.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/agents-v2.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — the deprecated wrappers preserve backward compatibility so `runtime.ts` imports still resolve.

- [ ] **Step 6: Commit**

```bash
git add packages/core/agents.ts packages/core/agents-v2.test.ts
git commit -m "feat: rewrite agents.ts with defineAgent builder pattern"
```

---

### Task 12: Register Orchestrator Tools in ToolRegistry

**Files:**
- Modify: `packages/core/tools.ts`

- [ ] **Step 1: Write test for tool registration**

Create `packages/core/tools-registry.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { createOrchestratorToolEntries } from "./tools";
import type { OrchestratorToolDeps } from "./tools";

function makeDeps(): OrchestratorToolDeps {
  return {
    registry: {},
    getRunContext: () => ({ runId: "r1", turnId: "t1", sessionId: "s1" }),
    createDelegation: () => ({
      chatId: "c1", sessionId: "s1", parentRunId: "r1", parentTurnId: "t1",
      agentId: "code", task: "x", status: "active" as const,
      createdAt: 1, updatedAt: 1, attempts: 0, maxRetries: 1, timeoutMs: 20000,
    }),
    getChat: () => undefined,
    closeChat: () => undefined,
    getQueuePosition: () => undefined,
    traceToolEvent: async () => {},
  };
}

describe("createOrchestratorToolEntries", () => {
  test("returns ToolEntry array with correct names", () => {
    const entries = createOrchestratorToolEntries(makeDeps());
    const names = entries.map((e) => e.name);
    expect(names).toContain("list_agents");
    expect(names).toContain("delegate");
    expect(names).toContain("delegate_task");
    expect(names).toContain("get_chat_status");
    expect(names).toContain("get_chat_result");
    expect(names).toContain("close_chat");
  });

  test("entries have source=local and defaultPermission=allow", () => {
    const entries = createOrchestratorToolEntries(makeDeps());
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.defaultPermission).toBe("allow");
      expect(entry.available).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/tools-registry.test.ts`
Expected: FAIL — `createOrchestratorToolEntries` doesn't exist.

- [ ] **Step 3: Add createOrchestratorToolEntries to tools.ts**

In `packages/core/tools.ts`, add a new export function that wraps the existing `createOrchestratorTools` output into `ToolEntry[]`:

```ts
import type { ToolEntry } from "./tool-registry";

export function createOrchestratorToolEntries(deps: OrchestratorToolDeps): ToolEntry[] {
  const agentTools = createOrchestratorTools(deps);
  return agentTools.map((tool) => ({
    name: tool.name,
    source: "local" as const,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    defaultPermission: "allow" as const,
    available: true,
  }));
}
```

Keep `createOrchestratorTools` as-is for backward compatibility during migration.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/tools-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/tools.ts packages/core/tools-registry.test.ts
git commit -m "feat: add createOrchestratorToolEntries for ToolRegistry integration"
```

---

### Task 13: Specialist-to-Specialist Delegation Tool

**Files:**
- Create: `packages/core/delegation.ts`
- Create: `packages/core/delegation.test.ts`

- [ ] **Step 1: Write failing tests for createRestrictedDelegateTool**

Create `packages/core/delegation.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { createRestrictedDelegateTool } from "./delegation";
import type { AgentChat } from "./contracts";

function makeDeps() {
  const chats = new Map<string, AgentChat>();
  return {
    createDelegation: (input: { agentId: string; task: string }) => {
      const chat: AgentChat = {
        chatId: `chat_${Date.now()}`, sessionId: "s1",
        parentRunId: "r1", parentTurnId: "t1",
        agentId: input.agentId, task: input.task,
        status: "active" as const,
        createdAt: Date.now(), updatedAt: Date.now(),
        attempts: 0, maxRetries: 1, timeoutMs: 20000,
      };
      chats.set(chat.chatId, chat);
      return chat;
    },
    getChat: (id: string) => chats.get(id),
    closeChat: (id: string) => { const c = chats.get(id); if (c) c.status = "closed"; return c; },
    getQueuePosition: () => undefined,
    traceToolEvent: async () => {},
    getRunContext: () => ({ runId: "r1", turnId: "t1", sessionId: "s1" }),
  };
}

describe("createRestrictedDelegateTool", () => {
  test("delegates to allowed target", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "math", task: "compute 2+2" });
    expect(result.content[0].text).toContain("math");
    expect(result.content[0].text).toContain("chatId");
  });

  test("rejects target not in allowedTargets", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "search", task: "find stuff" });
    expect(result.content[0].text).toContain("not allowed");
  });

  test("rejects when maxDepth exceeded", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 2,
      currentDepth: 2,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "math", task: "compute" });
    expect(result.content[0].text).toContain("depth");
  });

  test("detects cycle in delegationChain", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "math",
      allowedTargets: ["code"],
      maxDepth: 5,
      currentDepth: 2,
      delegationChain: ["orchestrator", "code", "math"],
      deps: makeDeps(),
    });

    // "code" is already in the chain → cycle
    const result = await tool.execute("tc1", { agentId: "code", task: "refactor" });
    expect(result.content[0].text).toContain("cycle");
  });

  test("tool name is 'delegate' (not delegate_task)", () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    expect(tool.name).toBe("delegate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/delegation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement createRestrictedDelegateTool**

Create `packages/core/delegation.ts`:

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentChat, RunContext } from "./contracts";

const delegateParams = Type.Object({
  agentId: Type.String({ description: "Target specialist id." }),
  task: Type.String({ description: "Task to delegate." }),
  context: Type.Optional(Type.String({ description: "Optional extra context." })),
});

type DelegateParams = Static<typeof delegateParams>;

export interface DelegationDeps {
  createDelegation: (input: { agentId: string; task: string; context?: string; runContext: RunContext }) => AgentChat;
  getChat: (chatId: string) => AgentChat | undefined;
  closeChat: (chatId: string) => AgentChat | undefined;
  getQueuePosition: (chatId: string) => number | undefined;
  traceToolEvent: (input: { type: string; status: string; runContext: RunContext; toolName: string; toolCallId: string; details?: Record<string, unknown> }) => Promise<void>;
  getRunContext: () => RunContext;
}

export interface RestrictedDelegateOptions {
  fromAgentId: string;
  allowedTargets: string[];
  maxDepth: number;
  currentDepth: number;
  delegationChain: string[];
  deps: DelegationDeps;
}

export function createRestrictedDelegateTool(options: RestrictedDelegateOptions): AgentTool<any> {
  const { fromAgentId, allowedTargets, maxDepth, currentDepth, delegationChain, deps } = options;

  return {
    name: "delegate",
    label: "Delegate task to specialist",
    description: `Delegate a task to a specialist. Allowed targets: ${allowedTargets.join(", ")}.`,
    parameters: delegateParams,
    execute: async (toolCallId: string, params: DelegateParams) => {
      // 1. Check depth
      if (currentDepth >= maxDepth) {
        return {
          content: [{ type: "text", text: `Cannot delegate: max depth ${maxDepth} reached.` }],
        };
      }

      // 2. Check target whitelist
      if (!allowedTargets.includes(params.agentId)) {
        return {
          content: [{ type: "text", text: `Agent '${params.agentId}' is not allowed. Allowed: ${allowedTargets.join(", ")}.` }],
        };
      }

      // 3. Check cycle
      if (delegationChain.includes(params.agentId)) {
        return {
          content: [{ type: "text", text: `Delegation cycle detected: ${[...delegationChain, params.agentId].join(" → ")}.` }],
        };
      }

      // 4. Delegate
      const runContext = deps.getRunContext();
      const chat = deps.createDelegation({
        agentId: params.agentId,
        task: params.task,
        context: params.context,
        runContext: {
          ...runContext,
          delegationDepth: currentDepth + 1,
          delegationChain: [...delegationChain, fromAgentId],
        },
      });

      return {
        content: [{ type: "text", text: `Delegated to ${params.agentId}. chatId=${chat.chatId}.` }],
        details: { chatId: chat.chatId, fromAgentId, targetAgentId: params.agentId },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/delegation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/delegation.ts packages/core/delegation.test.ts
git commit -m "feat: add createRestrictedDelegateTool with depth, whitelist, and cycle checks"
```

---

### Task 14: Scheduler Agent Tools

**Files:**
- Create: `packages/core/scheduler-tools.ts`
- Create: `packages/core/scheduler-tools.test.ts`

- [ ] **Step 1: Write failing tests for scheduler tools**

Create `packages/core/scheduler-tools.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { createSchedulerToolEntries } from "./scheduler-tools";
import { Scheduler } from "./scheduler";
import type { ToolEntry } from "./tool-registry";

function makeScheduler() {
  return new Scheduler({
    persistJob: async () => {},
    restoreJobs: async () => [],
    executeTask: async () => "done",
    trace: async () => {},
  });
}

describe("createSchedulerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createSchedulerToolEntries({
      scheduler: makeScheduler(),
      sessionId: "s1",
      callerAgentId: "orchestrator",
      allowedTargets: null,
    });
    const names = entries.map(e => e.name);
    expect(names).toContain("schedule_task");
    expect(names).toContain("list_scheduled_jobs");
    expect(names).toContain("cancel_scheduled_job");
  });

  test("schedule_task has hitl permission, list has allow, cancel has hitl", () => {
    const entries = createSchedulerToolEntries({
      scheduler: makeScheduler(),
      sessionId: "s1",
      callerAgentId: "orchestrator",
      allowedTargets: null,
    });
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["schedule_task"]).toBe("hitl");
    expect(perms["list_scheduled_jobs"]).toBe("allow");
    expect(perms["cancel_scheduled_job"]).toBe("hitl");
  });

  test("schedule_task validates targetAgentId against allowedTargets", async () => {
    const scheduler = makeScheduler();
    const entries = createSchedulerToolEntries({
      scheduler,
      sessionId: "s1",
      callerAgentId: "code",
      allowedTargets: ["math"],
    });
    const scheduleTool = entries.find(e => e.name === "schedule_task")!;

    // Allowed target
    const ok = await scheduleTool.execute("tc1", {
      targetAgentId: "math", task: "compute", cron: "* * * * *",
    });
    expect(ok.content[0].text).toContain("Scheduled");

    // Self is always allowed
    const self = await scheduleTool.execute("tc2", {
      targetAgentId: "code", task: "self task", cron: "0 * * * *",
    });
    expect(self.content[0].text).toContain("Scheduled");

    // Not allowed target
    const denied = await scheduleTool.execute("tc3", {
      targetAgentId: "search", task: "find", cron: "0 0 * * *",
    });
    expect(denied.content[0].text).toContain("not allowed");

    scheduler.shutdown();
  });

  test("list_scheduled_jobs returns current jobs", async () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "test",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "* * * * *" },
    });

    const entries = createSchedulerToolEntries({
      scheduler, sessionId: "s1",
      callerAgentId: "orchestrator", allowedTargets: null,
    });
    const listTool = entries.find(e => e.name === "list_scheduled_jobs")!;
    const result = await listTool.execute("tc1", {});
    expect(result.content[0].text).toContain("code");
    scheduler.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/scheduler-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scheduler tool entries**

Create `packages/core/scheduler-tools.ts`:

```ts
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { Scheduler } from "./scheduler";

interface SchedulerToolOptions {
  scheduler: Scheduler;
  sessionId: string;
  callerAgentId: string;
  allowedTargets: string[] | null; // null = any target allowed (orchestrator)
}

export function createSchedulerToolEntries(opts: SchedulerToolOptions): ToolEntry[] {
  const { scheduler, sessionId, callerAgentId, allowedTargets } = opts;

  const scheduleTask: ToolEntry = {
    name: "schedule_task",
    source: "local",
    description: "Schedule a task for an agent (cron, once, or delayed).",
    parameters: Type.Object({
      targetAgentId: Type.String({ description: "Agent to execute the task." }),
      task: Type.String({ description: "Task description." }),
      cron: Type.Optional(Type.String({ description: "Cron pattern (5-field)." })),
      runAt: Type.Optional(Type.String({ description: "ISO date for one-time execution." })),
      delayMs: Type.Optional(Type.Number({ description: "Delay in ms from now." })),
    }),
    execute: async (_toolCallId, params) => {
      const target = params.targetAgentId as string;

      // Validate target: must be self or in allowedTargets
      if (target !== callerAgentId && allowedTargets !== null && !allowedTargets.includes(target)) {
        return {
          content: [{ type: "text", text: `Target '${target}' is not allowed. Allowed: self (${callerAgentId}), ${(allowedTargets ?? []).join(", ")}.` }],
        };
      }

      const schedule = params.cron
        ? { type: "cron" as const, cron: params.cron as string }
        : params.runAt
          ? { type: "once" as const, runAt: new Date(params.runAt as string).getTime() }
          : { type: "delay" as const, delayMs: params.delayMs as number };

      const job = scheduler.addJob({
        sessionId,
        createdBy: callerAgentId,
        targetAgentId: target,
        task: params.task as string,
        schedule,
      });

      return {
        content: [{ type: "text", text: `Scheduled job ${job.jobId} for ${target}. Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "computing"}.` }],
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  const listJobs: ToolEntry = {
    name: "list_scheduled_jobs",
    source: "local",
    description: "List all active and paused scheduled jobs.",
    parameters: Type.Object({}),
    execute: async () => {
      const jobs = scheduler.listJobs();
      if (jobs.length === 0) {
        return { content: [{ type: "text", text: "No scheduled jobs." }] };
      }
      const summary = jobs.map(j =>
        `${j.jobId}: ${j.targetAgentId} — "${j.task}" [${j.status}] next=${j.nextRunAt ? new Date(j.nextRunAt).toISOString() : "none"}`
      ).join("\n");
      return { content: [{ type: "text", text: summary }] };
    },
    defaultPermission: "allow",
    available: true,
  };

  const cancelJob: ToolEntry = {
    name: "cancel_scheduled_job",
    source: "local",
    description: "Cancel an active or paused scheduled job.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job ID to cancel." }),
    }),
    execute: async (_toolCallId, params) => {
      const removed = scheduler.removeJob(params.jobId as string);
      return {
        content: [{ type: "text", text: removed ? `Job ${params.jobId} cancelled.` : `Job ${params.jobId} not found.` }],
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [scheduleTask, listJobs, cancelJob];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/scheduler-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/scheduler-tools.ts packages/core/scheduler-tools.test.ts
git commit -m "feat: add schedule_task, list_scheduled_jobs, cancel_scheduled_job tool entries"
```

---

### Task 15: Runtime Integration

**Files:**
- Modify: `packages/core/runtime.ts`

This is the largest task — it rewires the runtime to use ToolRegistry, AgentDefinitions, wrapTool, prompt compiler, and scheduler. This task is broken into sub-steps.

- [ ] **Step 1: Update runtime constructor signature**

Change `MultiAgentRuntime` constructor to accept an options object:

```ts
import { ToolRegistry } from "./tool-registry";
import { type AgentDefinition } from "./agent-builder";
import { type HITLHandler } from "./tool-middleware";
import { compileSystemPrompt } from "./prompt-compiler";
import { wrapTool, resolvePermission } from "./tool-middleware";
import { createOrchestratorToolEntries } from "./tools";
import { Scheduler } from "./scheduler";
import { ORCHESTRATOR_ID, createAgentDefinitions } from "./agents";

export interface RuntimeOptions {
  sessionId?: string;
  agents?: AgentDefinition[];
  hitlHandler?: HITLHandler;
  mcpServers?: McpServerConfig[];
  schedules?: Array<{ id: string; cron: string; agentId: string; task: string }>;
}
```

Constructor creates ToolRegistry, registers orchestrator tools + agent local tools, connects MCP servers, and initializes Scheduler.

- [ ] **Step 2: Update createAgentForRoute to use new pipeline**

Replace the current `createAgentForRoute` with:

```ts
private createAgentForRoute(toAgentId: string, runContext: RunContext): Agent {
  const def = this.agentDefs.get(toAgentId);
  if (!def) throw new Error(`Agent '${toAgentId}' is not registered.`);

  // 1. Resolve tools from registry
  let resolvedTools = this.toolRegistry.resolve(def.toolRefs);

  // 2. Add orchestrator tools if this is the orchestrator
  if (toAgentId === ORCHESTRATOR_ID) {
    const orchTools = this.toolRegistry.resolve([
      "list_agents", "delegate", "delegate_task",
      "get_chat_status", "get_chat_result", "close_chat",
    ]);
    resolvedTools = [...resolvedTools, ...orchTools];
  }

  // 3. Wrap each tool
  const wrappedTools = resolvedTools.map((tool) => {
    const permission = resolvePermission(
      undefined,
      def.permissions,
      tool.name,
      this.toolRegistry.get(tool.name)?.defaultPermission ?? "deny",
    );
    return wrapTool(tool, {
      permission,
      hitlHandler: this.hitlHandler,
      hooks: def.hooks,
      agentId: toAgentId,
      tracePermission: async (info) => {
        await this.trace({
          type: "tool_permission_check",
          status: "ok",
          runId: runContext.runId,
          turnId: runContext.turnId,
          agentId: toAgentId,
          toolName: info.toolName,
          details: { permission: info.permission, resolved: info.resolved },
        });
      },
    });
  });

  // 4. Compile prompt
  const compiledPrompt = compileSystemPrompt(def, resolvedTools);

  // 5. Create agent
  return def.createAgent(wrappedTools, compiledPrompt);
}
```

- [ ] **Step 3: Update listAgents to use AgentDefinitions**

```ts
listAgents() {
  return [...this.agentDefs.values()].map((def) => ({
    id: def.id,
    name: def.name,
    role: def.role,
    capabilities: def.capabilities,
    maxConcurrency: def.maxConcurrency,
  }));
}
```

- [ ] **Step 4: Wire up Scheduler**

In the constructor, after ChatManager setup:

```ts
this.scheduler = new Scheduler({
  persistJob: (job) => this.store.appendJob(job),
  restoreJobs: () => this.store.getJobRecords(),
  executeTask: async (agentId, task) => {
    const result = await this.chat({ toAgentId: agentId, content: task });
    return result.answer;
  },
  trace: async (event) => {
    await this.trace({
      ...event,
      sessionId: this.sessionId,
    } as any);
  },
});

// Add config-driven schedules
if (options.schedules) {
  for (const sched of options.schedules) {
    this.scheduler.addJob({
      sessionId: this.sessionId,
      createdBy: "runtime",
      targetAgentId: sched.agentId,
      task: sched.task,
      schedule: { type: "cron", cron: sched.cron },
    });
  }
}

// Restore persisted jobs
void this.scheduler.restore();
```

- [ ] **Step 5: Add backward-compatible constructor overload**

To preserve the old `new MultiAgentRuntime("session-id")` call from CLI and tests, add overload logic:

```ts
constructor(optionsOrSessionId?: RuntimeOptions | string) {
  const options: RuntimeOptions = typeof optionsOrSessionId === "string"
    ? { sessionId: optionsOrSessionId }
    : optionsOrSessionId ?? {};

  this.sessionId = options.sessionId ?? "default";
  // ... rest of constructor
}
```

When `agents` is not provided, default to `createAgentDefinitions()`.
When `hitlHandler` is not provided, default to a deny-all handler (backward compat with existing non-HITL usage).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — fix any type errors introduced.

- [ ] **Step 7: Run all existing tests**

Run: `bun test`
Expected: All PASS. The existing `ChatManager` tests and any runtime usage should work unchanged thanks to the backward-compatible constructor.

- [ ] **Step 8: Commit**

```bash
git add packages/core/runtime.ts
git commit -m "feat: integrate ToolRegistry, AgentDefinitions, wrapTool, prompt compiler, and Scheduler into runtime"
```

---

### Task 16: CLI Integration

**Files:**
- Modify: `apps/cli/index.ts`

- [ ] **Step 1: Add CLI HITL handler**

Add a `createCliHitlHandler` function that prompts the user via readline:

```ts
import type { HITLHandler, HITLRequest } from "../../packages/core/tool-middleware";

function createCliHitlHandler(rl: ReturnType<typeof createInterface>): HITLHandler {
  return async (request: HITLRequest): Promise<{ approved: boolean; modifiedParams?: Record<string, unknown> }> => {
    console.log(`\n[HITL] Agent '${request.agentId}' wants to use '${request.toolName}'`);
    console.log(`  Params: ${JSON.stringify(request.params, null, 2)}`);
    const answer = await rl.question("  Approve? [y/N]: ");
    const approved = answer.trim().toLowerCase() === "y";
    return { approved };
  };
}
```

- [ ] **Step 2: Update runtime construction**

Change the runtime creation to use new constructor:

```ts
import { createAgentDefinitions } from "../../packages/core/agents";

// After creating readline interface:
const runtime = new MultiAgentRuntime({
  sessionId: args.sessionId,
  agents: createAgentDefinitions(),
  hitlHandler: createCliHitlHandler(rl),
});
```

For smoke mode (no interactive readline), use a deny-all handler.

- [ ] **Step 3: Add /scheduled and /cancel-job commands**

```ts
if (command === "/scheduled") {
  const jobId = args[0];
  if (jobId) {
    const job = runtime.scheduler?.getJob(jobId);
    console.log(job ? JSON.stringify(job, null, 2) : "Job not found.");
  } else {
    const jobs = runtime.scheduler?.listJobs() ?? [];
    console.log(JSON.stringify(jobs, null, 2));
  }
  continue;
}
if (command === "/cancel-job") {
  const jobId = args[0];
  if (!jobId) { console.log("Uso: /cancel-job <jobId>"); continue; }
  const removed = runtime.scheduler?.removeJob(jobId);
  console.log(removed ? "Job cancelled." : "Job not found.");
  continue;
}
```

- [ ] **Step 4: Update printHelp**

Add the new commands to the help text.

- [ ] **Step 5: Run the CLI manually to verify**

Run: `bun run start -- --session test-hitl`
Expected: CLI starts, shows agents, accepts commands. New commands `/scheduled` and `/cancel-job` work.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/index.ts
git commit -m "feat: add CLI HITL handler, /scheduled and /cancel-job commands"
```

---

### Task 17: Web Backend Integration

**Files:**
- Modify: `apps/backend/server.ts`

- [ ] **Step 1: Add WebSocket HITL handler**

```ts
import type { HITLHandler } from "../../packages/core/tool-middleware";

function createWebHitlHandler(clients: Set<WsClient>): HITLHandler {
  return (request) => {
    return new Promise((resolve) => {
      const reqId = crypto.randomUUID();
      const msg = JSON.stringify({ type: "hitl_request", reqId, ...request });
      for (const ws of clients) {
        try { ws.send(msg); } catch {}
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ approved: false });
        }
      }, request.timeout);

      // Store resolver for when response comes back
      hitlPending.set(reqId, (response) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(response);
      });
    });
  };
}

const hitlPending = new Map<string, (response: { approved: boolean; modifiedParams?: Record<string, unknown> }) => void>();
```

- [ ] **Step 2: Handle hitl_response in WebSocket message handler**

In the `message(ws, data)` handler, add:

```ts
else if (msg.type === "hitl_response") {
  const reqId = msg.reqId as string;
  const resolver = hitlPending.get(reqId);
  if (resolver) {
    hitlPending.delete(reqId);
    resolver({
      approved: msg.approved as boolean,
      modifiedParams: msg.modifiedParams as Record<string, unknown> | undefined,
    });
  }
}
```

- [ ] **Step 3: Update runtime construction**

```ts
import { createAgentDefinitions } from "../../packages/core/agents";

const runtime = new MultiAgentRuntime({
  sessionId,
  agents: createAgentDefinitions(),
  hitlHandler: createWebHitlHandler(clients),
});
```

- [ ] **Step 4: Add /api/jobs routes**

```ts
"/api/jobs": {
  GET: () => Response.json(runtime.scheduler?.listJobs() ?? []),
},
"/api/jobs/:id": {
  GET: (req) => {
    const job = runtime.scheduler?.getJob(req.params.id);
    return job ? Response.json(job) : Response.json({ error: "not found" }, { status: 404 });
  },
  DELETE: (req) => {
    const removed = runtime.scheduler?.removeJob(req.params.id);
    return removed ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
  },
},
```

- [ ] **Step 5: Add job lifecycle broadcast (monkey-patch appendJob)**

```ts
const _appendJob = runtime.store.appendJob.bind(runtime.store);
(runtime.store as any).appendJob = async (job: ScheduledJob) => {
  await _appendJob(job);
  broadcast({ type: "job_lifecycle", job });
};
```

- [ ] **Step 6: Run the web server manually to verify**

Run: `bun run ui -- --session test-web`
Expected: Server starts on port 3000, `/api/jobs` returns `[]`, WebSocket connects.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/server.ts
git commit -m "feat: add WebSocket HITL handler, /api/jobs routes, job lifecycle broadcast"
```

---

### Task 18: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to the CLI commands section:
- `/scheduled` — list all scheduled jobs
- `/scheduled <jobId>` — show job details
- `/cancel-job <jobId>` — cancel a scheduled job

Update the "Project Context" section to mention:
- `packages/core/tool-registry.ts` — ToolRegistry with glob resolution
- `packages/core/agent-builder.ts` — `defineAgent()` builder
- `packages/core/prompt-compiler.ts` — system prompt compilation
- `packages/core/tool-middleware.ts` — `wrapTool()` with permissions/HITL/hooks
- `packages/core/mcp-client.ts` — MCP protocol types and helpers
- `packages/core/scheduler.ts` — cron jobs and scheduled tasks

Update the REST API table with `/api/jobs` endpoints.
Update the WebSocket protocol with `hitl_request`/`hitl_response` and `job_lifecycle` messages.

- [ ] **Step 2: Update README.md**

Add sections covering:
- Agent definitions with builder pattern
- HITL permission system
- Scheduler and cron jobs
- MCP tool integration
- New CLI commands

- [ ] **Step 3: Update AGENTS.md**

Update to reflect new extensible agent architecture:
- Document `defineAgent()` builder pattern with all options
- Document `ToolRegistry` and how tools are registered/resolved
- Document `wrapTool()` middleware and permission system (`allow`/`deny`/`hitl`)
- Document specialist-to-specialist delegation (`canDelegateTo`, depth limits, cycle detection)
- Document scheduler integration (`schedule()` builder method)
- Document MCP tool integration (`connectMcp`/`disconnectMcp`, `mcp:prefix/*` patterns)
- Update any agent descriptions to reflect the new dynamic agent definitions

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: update README, CLAUDE.md, and AGENTS.md with extensible agents, HITL, scheduler, MCP"
```

---

### Task 19: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Run smoke tests**

```bash
bun run smoke:math
bun run smoke:code
bun run smoke:orchestrator
```

Expected: All smoke tests produce valid output (existing behavior preserved).

- [ ] **Step 4: Test CLI HITL manually**

Run: `bun run start -- --session hitl-test`
- Switch to an agent with HITL permissions
- Trigger a tool that requires approval
- Verify the prompt appears and approval/denial works

- [ ] **Step 5: Test scheduler manually**

Run: `bun run start -- --session sched-test`
- Use `/scheduled` to verify no jobs
- Add a config-driven schedule in the runtime options and restart
- Verify `/scheduled` shows the job

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: final adjustments from integration testing"
```
