# Extensible Agents with MCP Tools, Skills, and HITL

**Date:** 2026-03-17
**Status:** Draft
**Approach:** Tool Registry centralizado (Enfoque A)

---

## Summary

Extend the pi-agent-core multi-agent runtime so that:

1. Agents can have their own tools (local TypeScript functions + MCP server tools).
2. Agents have enriched system prompts with rules, examples, and auto-generated tool docs.
3. Specialists can delegate to other specialists (limited depth, cycle detection).
4. A permission system controls tool access with human-in-the-loop (HITL) approval for dangerous operations.
5. A scheduler supports config-driven and agent-driven cron jobs with persistent JSONL storage and restore-on-restart.

The design preserves all existing behavior (ChatManager, ThreadStore, traces, CLI commands) and introduces new modules alongside existing ones.

---

## 1. ToolRegistry

An instance (not singleton) created per `MultiAgentRuntime` — this preserves testability and allows multiple runtimes with different tool configurations.

### ToolEntry

```ts
interface ToolEntry {
  name: string                    // "read_file" or "mcp:filesystem/read_file"
  source: "local" | "mcp"
  mcpServer?: string              // "filesystem" if source=mcp
  description: string
  parameters: TSchema | JsonSchema // TypeBox schema or raw JSON Schema (from MCP)
  execute: ToolExecuteFn
  defaultPermission: Permission   // "allow" | "deny" | "hitl"
  available: boolean              // false if MCP server disconnected
}

type Permission = "allow" | "deny" | "hitl"
```

**Note on `parameters`:** Local tools use TypeBox `TSchema`. MCP tools return raw JSON Schema from `tools/list` — these are wrapped via `Type.Unsafe()` from TypeBox to produce a compatible `TSchema`. A `normalizeSchema(input: TSchema | JsonSchema): TSchema` helper handles conversion.

### API

```ts
interface ToolRegistry {
  register(tool: ToolEntry): void
  connectMcp(name: string, config: McpServerConfig): Promise<void>
  disconnectMcp(name: string): Promise<void>
  get(name: string): ToolEntry | undefined
  list(): ToolEntry[]
  resolve(refs: string[]): AgentTool[]  // supports globs like "mcp:filesystem/*"
}
```

**Glob matching:** Both `resolve()` and permission key matching use simple prefix-based glob: `"mcp:filesystem/*"` matches any tool whose name starts with `"mcp:filesystem/"`. No external glob library needed.

### MCP Integration

- `connectMcp()` connects to an MCP server via stdio or HTTP transport.
- Calls `tools/list` to discover tools and wraps each as a `ToolEntry` with `source: "mcp"`.
- Raw JSON Schema parameters from MCP are converted via `Type.Unsafe()`.
- Execution calls `tools/call` against the server.
- The registry manages MCP client lifecycle (connect/disconnect).

### MCP Error Handling and Recovery

- **Disconnect during idle:** tools are marked `available: false`. `resolve()` skips unavailable tools. A `tool_unavailable` trace event is emitted.
- **Disconnect during in-flight `tools/call`:** the `execute` wrapper rejects with `McpDisconnectedError`. This propagates through the middleware chain (hooks catch it, permission layer passes it through). The agent receives a tool error and can retry or report failure.
- **Reconnection policy:** automatic reconnect with exponential backoff (1s, 2s, 4s, max 30s, max 5 attempts). On successful reconnect, tools are re-discovered via `tools/list` and marked available again.
- **Permanent failure:** after max reconnect attempts, the MCP server is marked `failed`. The runtime emits a `mcp_server_failed` trace event. The CLI/Web UI surfaces this as a warning to the user.
- **No auto-reconnect on first connect failure:** `connectMcp()` throws immediately if the initial connection fails, so the runtime can report it at startup.

**Primary file:** `packages/core/tool-registry.ts`

---

## 2. Agent Definition (Builder Pattern)

Replaces the current `createXxxAgent()` functions in `agents.ts` with a declarative builder.

### Builder API

```ts
const codeAgent = defineAgent("code")
  .name("Code Specialist")
  .role("Creates focused code snippets, refactors, and bug fixes.")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt("You are a coding specialist...")
  .rules([
    "Always read a file before modifying it.",
    "Never execute destructive commands without explicit user request.",
  ])
  .examples([
    { user: "Fix the bug in server.ts", assistant: "Let me read the file first..." }
  ])
  .tools(["read_file", "write_file", "run_command"])
  .mcpTools(["mcp:filesystem/*"])
  .canDelegateTo(["math"], { maxDepth: 2 })
  .permissions({
    "run_command": "hitl",
    "write_file": "hitl",
    "read_file": "allow",
    "mcp:filesystem/*": "allow",
  })
  .hooks({
    beforeTool: async (toolName, params, ctx) => { return params },
    afterTool: async (toolName, result, ctx) => { return result },
  })
  .maxConcurrency(1)
  .build()
```

### AgentDefinition (output of `.build()`)

```ts
interface AgentDefinition {
  id: string
  name: string
  role: string
  capabilities: string[]
  modelConfig: AgentModelConfig
  systemPrompt: string
  rules: string[]
  examples: Array<{ user: string; assistant: string }>
  toolRefs: string[]              // tool names + MCP globs to resolve from registry
  localTools?: ToolEntry[]        // tools exclusive to this agent (also registered)
  delegationRules: {
    targets: string[]
    maxDepth: number
  } | null
  permissions: Record<string, Permission>
  hooks: AgentHooks
  maxConcurrency: number
  createAgent: (resolvedTools: AgentTool[], compiledPrompt: string) => Agent
  // Note: createAgent is a closure produced by .build() that captures the model
  // reference internally. The builder calls modelFor() at build time and binds it:
  //   createAgent: (tools, prompt) => new Agent({
  //     initialState: { systemPrompt: prompt, model: capturedModel, tools, messages: [] }
  //   })
}
```

### Builder Validation

`.build()` validates required fields and throws descriptive errors:

- `id` — required, non-empty
- `model` — required (provider + modelId)
- `systemPrompt` or `role` — at least one must be set

### Orchestrator

The orchestrator is also defined via the builder. Its built-in tools (list_agents, delegate, get_chat_status, get_chat_result, close_chat, delegate_task) are registered in the ToolRegistry as local tools. The `delegate_task` alias is only registered for the orchestrator — specialists with `canDelegateTo` get only the `delegate` tool.

**Primary file:** `packages/core/agent-builder.ts`

---

## 3. Permission System and HITL

### Permission Resolution Order

```text
1. Runtime override (e.g., user toggled "allow all" for this session)
2. Agent definition permissions
3. ToolEntry.defaultPermission
4. Fallback: "deny"
```

### HITL Interface

```ts
interface HITLRequest {
  agentId: string
  toolName: string
  params: Record<string, unknown>
  reason: string
  timeout: number               // ms, default 60_000
}

interface HITLResponse {
  approved: boolean
  modifiedParams?: Record<string, unknown>
}

type HITLHandler = (request: HITLRequest) => Promise<HITLResponse>
```

### HITL Timeout Behavior

When the HITL timeout expires:

- The tool call is **denied** — returns an error message `"Approval timed out, tool denied"` to the agent.
- This does **not** count as a chat-level failure — the agent can recover (try a different approach, skip the tool, or ask the user).
- **Interaction with ChatManager timeout:** when a HITL prompt is pending, the ChatManager's chat-level timeout (`DEFAULT_TIMEOUT_MS = 20_000`) is **paused**. It resumes after the HITL response is received. This prevents a 60-second HITL approval from triggering a 20-second chat timeout. Implementation: the chat runner receives a `pauseTimeout()` / `resumeTimeout()` pair from ChatManager.

### Implementations

- **CLI:** prints to terminal, waits for `[y/N/edit]` input.
- **Web UI:** sends WebSocket message `{ type: "hitl_request", ... }`, waits for `{ type: "hitl_response", ... }`. Frontend shows a confirmation modal. HITL requests are sent to **all** connected clients (broadcast), but only the **first** response is accepted — subsequent responses are ignored. This matches the existing broadcast pattern in `server.ts`.

### Tool Wrapping

All middleware (permissions, HITL, hooks) is applied via a single `wrapTool()` function to prevent ordering bugs:

```ts
function wrapTool(tool: AgentTool, options: {
  permission: Permission
  hitlHandler: HITLHandler
  hooks?: AgentHooks
  agentId: string
}): AgentTool
```

This replaces the two separate `wrapWithPermissions` + `wrapWithHooks` passes described earlier. The execution order within `wrapTool` is:

```text
Agent calls tool
  → Permission check (allow/deny/hitl)
  → HITL prompt (if hitl, waits for human response)
  → beforeTool hook (validation, logging, param transform)
  → tool.execute()
  → afterTool hook (post-processing, logging)
  → result returned to agent
```

### New Trace Events

- `tool_permission_check` — which permission resolved
- `tool_hitl_requested` / `tool_hitl_approved` / `tool_hitl_denied` / `tool_hitl_timeout`

**Primary file:** `packages/core/tool-middleware.ts`

---

## 4. Specialist-to-Specialist Delegation

### Mechanism

When an agent is defined with `.canDelegateTo(targets, { maxDepth })`, the runtime injects a restricted `delegate` tool that only allows delegating to the specified targets.

### RunContext Extension

```ts
interface RunContext {
  runId: string
  turnId: string
  sessionId: string
  delegationDepth?: number     // new, optional — 0 for user→orchestrator, +1 per delegation
  delegationChain?: string[]   // new, optional — e.g., ["orchestrator", "code"]
}
```

Both fields are **optional** for backward compatibility — existing persisted traces and the current `createRunContext()` work unchanged. The runtime defaults `delegationDepth` to `0` and `delegationChain` to `[]` when not present.

### Specialist Delegation Tool Factory

When a specialist has `canDelegateTo`, the runtime creates a restricted delegate tool parameterized with the delegating agent's ID:

```ts
function createRestrictedDelegateTool(options: {
  fromAgentId: string              // the delegating specialist (NOT orchestrator)
  allowedTargets: string[]
  maxDepth: number
  currentDepth: number
  delegationChain: string[]
  // same deps as orchestrator delegate: createDelegation, getChat, etc.
  deps: DelegationDeps
}): AgentTool
```

Key difference from orchestrator's delegate: `fromAgentId` is the specialist, not `ORCHESTRATOR_ID`. The `routeMessage` call uses this to set the correct `fromAgentId`, and `delegationDepth` is incremented in the `RunContext` passed to the sub-chat runner.

### Protections

- **Max depth:** if `delegationDepth >= maxDepth`, delegate tool returns error.
- **Target whitelist:** if target is not in `allowedTargets`, delegate tool returns error.
- **Cycle detection:** if target already appears in `delegationChain`, delegate tool returns error.

### Example Flow

```text
user → orchestrator (depth=0) → code (depth=1) → math (depth=2) ✓
user → orchestrator (depth=0) → code (depth=1) → math (depth=2) → ??? ✗ maxDepth
orchestrator → code → math → code ✗ cycle detected
```

### What Doesn't Change

- `ChatManager` — same concurrency/queue logic regardless of who delegated.
- `ThreadStore` — already supports threads between any agent pair.
- Trace events gain `delegationDepth` and `delegationChain` in details.

---

## 5. Enriched System Prompts

### Prompt Layers

```text
1. Base prompt        — "You are a coding specialist..."
2. Tool descriptions  — auto-generated from resolved tools
3. Delegation info    — auto-generated if canDelegateTo is set
4. Behavioral rules   — from .rules([...])
5. Few-shot examples  — from .examples([...])
```

### Compilation

`compileSystemPrompt(def, resolvedTools)` concatenates the layers into a single string at agent creation time.

- Layer 2 lists each tool with name, description, and parameter summary.
- Layer 3 tells the agent which specialists it can delegate to and how.
- Layer 4 renders rules as a bulleted list.
- Layer 5 renders examples as User/Assistant pairs separated by `---`.

### Rules vs Hooks

- **Rules** are "soft" — the model follows them best-effort via prompt instructions. Use for style, preferences, domain knowledge.
- **Hooks** are "hard" — code that executes unconditionally. Use for security, validation, logging.

**Primary file:** `packages/core/prompt-compiler.ts`

---

## 6. Scheduler — Cron Jobs and Agent-Driven Tasks

Two mechanisms share the same infrastructure: config-driven schedules defined at startup, and agent-driven schedules created at runtime via a tool.

### 6.1 Config-Driven Schedules

Defined in the runtime constructor or in the agent builder:

```ts
// Runtime constructor
new MultiAgentRuntime({
  // ...agents, hitlHandler, mcpServers
  schedules: [
    { id: "cleanup", cron: "0 */6 * * *", agentId: "orchestrator", task: "Clean up chats older than 24h" },
    { id: "health",  cron: "*/5 * * * *", agentId: "code", task: "Run health check on monitored services" },
  ],
})

// Or in the agent builder
defineAgent("code")
  .schedule("health", "*/5 * * * *", "Run health check on monitored services")
  .build()
```

### 6.2 Agent-Driven Schedules (tool)

Any agent with permission can schedule future tasks for itself or any agent it can delegate to (respects `canDelegateTo`):

```ts
// The agent calls schedule_task:
schedule_task({
  targetAgentId: "math",                    // must be self or in canDelegateTo
  task: "Recalculate metrics for dashboard",
  schedule: "2026-03-18T09:00:00Z",        // absolute date (once)
  // or: cron: "0 9 * * *"                 // recurring
  // or: delayMs: 7200000                  // relative delay (once)
})
```

### 6.3 ScheduledJob (persisted)

```ts
interface ScheduledJob {
  jobId: string
  sessionId: string
  createdBy: string             // agentId that created it, or "runtime" for config-driven
  targetAgentId: string         // agent that will execute the task
  task: string
  schedule: {
    type: "cron" | "once" | "delay"
    cron?: string               // "*/5 * * * *" (standard 5-field)
    runAt?: number              // absolute timestamp for "once"
    delayMs?: number            // milliseconds from creation for "delay"
  }
  status: "active" | "paused" | "completed" | "failed"
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
  maxRuns?: number              // undefined = infinite for cron, 1 for once/delay
  createdAt: number
  updatedAt: number
  error?: string
}
```

### 6.4 Scheduler Class

```ts
class Scheduler {
  constructor(options: {
    persistJob: (job: ScheduledJob) => Promise<void>
    restoreJobs: () => Promise<ScheduledJob[]>
    executeTask: (agentId: string, task: string) => Promise<string>
    trace: (event: Omit<TraceEvent, "eventId" | "timestamp" | "sessionId">) => Promise<void>
  })

  addJob(input: CreateJobInput): ScheduledJob
  removeJob(jobId: string): boolean
  pauseJob(jobId: string): boolean
  resumeJob(jobId: string): boolean
  listJobs(): ScheduledJob[]
  getJob(jobId: string): ScheduledJob | undefined
  restore(): Promise<number>      // restore jobs from disk, return count
  shutdown(): void                // clear all timers
}
```

**Execution flow** when a job triggers:

1. Create a fresh `RunContext`
2. Call `executeTask(targetAgentId, task)` — internally does `runtime.chat()`
3. Trace `job_triggered` → `job_completed` or `job_failed`
4. Persist updated job state
5. For recurring cron, compute `nextRunAt` and re-arm timer

**Timer implementation:** Uses `setTimeout` internally. For cron patterns, a minimal 5-field parser computes the next run time (no external dependency). Each tick sets a new `setTimeout` for the next occurrence.

**Cron parsing:** Standard 5-field format (`minute hour day-of-month month day-of-week`). Supports `*`, ranges (`1-5`), steps (`*/5`), and lists (`1,3,5`). No seconds field, no year field. A simple `nextCronTick(pattern, fromDate): Date` function handles this.

### 6.5 Persistence

Jobs persist to `jobs.jsonl` via `ThreadStore` (same append-only strategy as `chats.jsonl`):

- Each state change appends the full `ScheduledJob` record
- On read, deduplicate by `jobId` (last record wins)
- `restore()` at startup: reload active jobs, recalculate `nextRunAt`, re-arm timers
- Jobs of type `once`/`delay` whose `runAt` has already passed execute immediately on restore
- Jobs of type `cron` that missed runs while the process was down do **not** backfill — they just compute and schedule the next future occurrence

### 6.6 Tools for Agents

Three tools registered in the `ToolRegistry`:

| Tool | Default permission | Description |
| --- | --- | --- |
| `schedule_task` | `hitl` | Create a scheduled job (cron, once, or delay) |
| `list_scheduled_jobs` | `allow` | List all active/paused jobs |
| `cancel_scheduled_job` | `hitl` | Cancel an active or paused job |

`schedule_task` validates that `targetAgentId` is either the calling agent itself or is in its `canDelegateTo` targets. If not, it fails with an error.

### 6.7 CLI Commands

| Command | Description |
| --- | --- |
| `/scheduled` | List all scheduled jobs |
| `/scheduled <jobId>` | Show job details |
| `/cancel-job <jobId>` | Cancel a scheduled job |

The existing `/jobs` alias for `/chats` remains unchanged.

### 6.8 New Trace Events

- `job_created` — job added to scheduler
- `job_triggered` — timer fired, execution starting
- `job_completed` — task finished successfully
- `job_failed` — task failed
- `job_cancelled` — job cancelled by user or agent
- `job_paused` / `job_resumed` — job paused/resumed

### 6.9 WebSocket Protocol Additions

**Server → Client:**

- `{ type: "job_lifecycle", job: ScheduledJob }` — job state change (same pattern as `chat_lifecycle`)
- `{ type: "job_triggered", jobId, targetAgentId, task }` — job execution starting

### 6.10 REST API Additions

| Route | Method | Description |
| --- | --- | --- |
| `/api/jobs` | GET | List all scheduled jobs |
| `/api/jobs/:id` | GET | Get job details |
| `/api/jobs/:id` | DELETE | Cancel a job |

**Primary file:** `packages/core/scheduler.ts`

---

## 7. Runtime Integration

### Constructor Change

```ts
class MultiAgentRuntime {
  constructor(options: {
    sessionId?: string
    agents: AgentDefinition[]
    hitlHandler: HITLHandler
    mcpServers?: McpServerConfig[]
    schedules?: ScheduleConfig[]   // config-driven cron jobs
  })
}
```

### Agent Creation Flow (`createAgentForRoute`)

1. Look up `AgentDefinition` by id.
2. Resolve tool refs from ToolRegistry (local + MCP, with glob support).
3. If agent has `delegationRules` and depth allows, inject restricted delegate tool (with correct `fromAgentId`).
4. Wrap each tool via single `wrapTool()` (permission + HITL + hooks in correct order).
5. Compile system prompt with resolved tools (cap tool descriptions at ~4000 chars to avoid context bloat with many MCP tools).
6. Create Agent via `def.createAgent(tools, prompt)` — model is pre-bound in the closure.

### Entry Points

CLI and Web backend construct the runtime with their respective HITL handler:

```ts
// CLI
new MultiAgentRuntime({
  sessionId,
  agents: [orchestratorDef, codeDef, mathDef],
  hitlHandler: createCliHitlHandler(),
  mcpServers: [{ name: "filesystem", transport: "stdio", command: "mcp-fs", args: ["."] }],
  schedules: [
    { id: "health", cron: "*/5 * * * *", agentId: "code", task: "Run health check" },
  ],
})

// Web
new MultiAgentRuntime({
  sessionId,
  agents: [orchestratorDef, codeDef, mathDef],
  hitlHandler: createWebHitlHandler(wsClients),
  mcpServers: [...],
  schedules: [...],
})
```

---

## 8. File Map

### New Files

| File | Responsibility |
| --- | --- |
| `packages/core/tool-registry.ts` | ToolRegistry + MCP client lifecycle |
| `packages/core/agent-builder.ts` | `defineAgent()` builder pattern |
| `packages/core/tool-middleware.ts` | `wrapTool()` — single function for permissions, HITL, and hooks |
| `packages/core/prompt-compiler.ts` | `compileSystemPrompt()` |
| `packages/core/mcp-client.ts` | MCP protocol wrapper (stdio/HTTP transport), `McpDisconnectedError` |
| `packages/core/scheduler.ts` | Scheduler class, cron parser, job lifecycle |

### Files to Modify

| File | Change |
| --- | --- |
| `packages/core/runtime.ts` | New constructor with `schedules`, `createAgentForRoute` uses registry, integrates `Scheduler` |
| `packages/core/agents.ts` | Rewritten with `defineAgent()`, exports AgentDefinitions |
| `packages/core/tools.ts` | Orchestrator tools registered in registry (not created inline) |
| `packages/core/contracts.ts` | `BaseAgentId` becomes `string`, `RunContext` gains optional `delegationDepth`/`delegationChain`, `ScheduledJob` type, new `TraceEvent.type` values: `tool_unavailable`, `mcp_server_failed`, `tool_permission_check`, `tool_hitl_requested`, `tool_hitl_approved`, `tool_hitl_denied`, `tool_hitl_timeout`, `job_created`, `job_triggered`, `job_completed`, `job_failed`, `job_cancelled`, `job_paused`, `job_resumed` |
| `apps/cli/index.ts` | New runtime constructor, `createCliHitlHandler()`, `/scheduled` and `/cancel-job` commands |
| `apps/backend/server.ts` | New runtime constructor, `createWebHitlHandler()`, HITL + job lifecycle WebSocket messages, `/api/jobs` REST endpoints |
| `packages/core/chat-manager.ts` | Minor: add `pauseTimeout()`/`resumeTimeout()` for HITL timeout interaction |
| `packages/core/thread-store.ts` | Add `appendJob()` and `getJobRecords()` for scheduler persistence (same pattern as `appendChatRecord`/`getChatRecords`) |

### Files Unchanged

| File | Why |
| --- | --- |
| `packages/core/errors.ts` | Error utilities unchanged |
| `packages/core/ids.ts` | ID generation unchanged |

---

## 9. Backward Compatibility

- `delegate_task` alias preserved as a registered tool in the registry.
- `createSpecialistRegistry()` can be kept as a convenience that wraps `defineAgent().build()`.
- Existing CLI commands (`/agents`, `/chats`, `/traces`, `/threads`) work unchanged.
- `ThreadEnvelope`, `TraceEvent`, `AgentChat` types only gain optional fields.
- WebSocket protocol adds `hitl_request`/`hitl_response` messages; existing messages unchanged.

---

## 10. Out of Scope (Future)

- Agent hot-reload (change definition without restart).
- MCP server discovery (auto-detect available servers).
- Tool result caching.
- Per-session permission overrides from the UI.
- Agent-to-agent direct messaging (bypassing delegation/chat).
