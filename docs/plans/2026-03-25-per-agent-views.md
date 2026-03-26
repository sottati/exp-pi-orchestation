# Per-Agent Views UI Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add sidebar navigation with per-agent dedicated views showing identity, activity history, filtered traces, and agent-specific resource panels (e.g., cron jobs for secretary).

**Architecture:** Sidebar (56px) with agent avatar icons for navigation. Clicking an agent switches the main panel to that agent's dedicated view (identity card + resources + activity feed). Home view = current orchestrator chat. Trace panel filters to the selected agent. Input bar sends messages directly to the selected agent.

**Tech Stack:** React (existing), Bun.serve() backend (existing), WebSocket (existing), CSS custom properties for per-agent accent colors.

---

## Agent Personality Definitions

Each agent gets:
- A unique **accent color** (CSS custom property)
- A unique **letter badge** (first letter, styled with accent)
- A short **tagline** reflecting personality

| Agent | Accent | Badge | Tagline |
|---|---|---|---|
| orchestrator (home) | `#ffffff` | `D` (Dithie) | "i delegate, therefore i am" |
| code | `#8be9fd` | `C` | "snippets, not speeches" |
| math | `#f1fa8c` | `M` | "numbers don't lie" |
| explorer | `#50fa7b` | `E` | "browsing the infinite" |
| writer | `#ff79c6` | `W` | "words are my craft" |
| debugger | `#ffb86c` | `B` | "finding bugs since boot" |
| secretary | `#bd93f9` | `S` | "your agenda, organized" |

---

### Task 1: Extract shared types to `apps/web/types.ts`

**Files:**
- Create: `apps/web/types.ts`
- Modify: `apps/web/app.tsx`

**Step 1: Write the types file**

Create `apps/web/types.ts` extracting all shared interfaces from `app.tsx`:

```ts
// apps/web/types.ts

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  maxConcurrency: number;
}

export interface TraceEvent {
  eventId: string;
  timestamp: number;
  type: string;
  status: string;
  agentId?: string;
  chatId?: string;
  toolCallId?: string;
  toolName?: string;
  details?: Record<string, unknown>;
}

export interface DelegationBlock {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  result?: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
}

export type DithieState = "idle" | "thinking" | "delegating" | "error";

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
  runId?: string;
  durationMs?: number;
  agentId?: string; // NEW: which agent this message is for/from
}

export interface ScheduledJobInfo {
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
  runCount: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  error?: string;
}

export type ChatItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "delegation"; delegationId: string };

// View can be "home" (orchestrator chat) or a specific agent id
export type ViewTarget = "home" | string;

export interface AgentPersonality {
  accent: string;
  badge: string;
  tagline: string;
}

export const AGENT_PERSONALITIES: Record<string, AgentPersonality> = {
  orchestrator: { accent: "#ffffff", badge: "D", tagline: "i delegate, therefore i am" },
  code:         { accent: "#8be9fd", badge: "C", tagline: "snippets, not speeches" },
  math:         { accent: "#f1fa8c", badge: "M", tagline: "numbers don't lie" },
  explorer:     { accent: "#50fa7b", badge: "E", tagline: "browsing the infinite" },
  writer:       { accent: "#ff79c6", badge: "W", tagline: "words are my craft" },
  debugger:     { accent: "#ffb86c", badge: "B", tagline: "finding bugs since boot" },
  secretary:    { accent: "#bd93f9", badge: "S", tagline: "your agenda, organized" },
};
```

**Step 2: Update `app.tsx` imports**

Replace inline type definitions in `app.tsx` with imports from `./types`. Remove the duplicated interface blocks. Keep everything else unchanged.

**Step 3: Verify the app still renders**

Run: `bun run typecheck`
Expected: PASS (no type errors)

**Step 4: Commit**

```bash
git add apps/web/types.ts apps/web/app.tsx
git commit -m "refactor(web): extract shared types to types.ts"
```

---

### Task 2: Add agent-specific REST endpoints to backend

**Files:**
- Modify: `apps/backend/server.ts`

**Step 1: Add `/api/agents/:id/activity` endpoint**

Add to the `routes` object in `server.ts`:

```ts
"/api/agents/:id/activity": {
    GET: async (req) => {
        const agentId = req.params.id;
        // Get traces filtered by agent
        const allTraces = await runtime.getTraces();
        const agentTraces = allTraces.filter(
            (t: TraceEvent) => t.agentId === agentId
        ).slice(-100);
        // Get chats involving this agent
        const allChats = runtime.listChats();
        const agentChats = allChats.filter(
            (c: AgentChat) => c.agentId === agentId
        );
        // Get jobs targeting this agent
        const allJobs = runtime.scheduler?.listJobs() ?? [];
        const agentJobs = allJobs.filter(
            (j: ScheduledJob) => j.targetAgentId === agentId || j.createdBy === agentId
        );
        return Response.json({ traces: agentTraces, chats: agentChats, jobs: agentJobs });
    },
},
```

**Step 2: Verify server starts**

Run: `bun run apps/backend/server.ts -- --session test`
Expected: Server starts on port 3000 without errors. Kill it after verifying.

**Step 3: Commit**

```bash
git add apps/backend/server.ts
git commit -m "feat(api): add /api/agents/:id/activity endpoint"
```

---

### Task 3: Create agent personality config and sidebar CSS

**Files:**
- Modify: `apps/web/app.css`

**Step 1: Add sidebar and agent-view CSS**

Append to `app.css`:

```css
/* ── Agent Accent Colors (CSS custom properties) ─────────────────────────── */

.agent-accent--orchestrator { --agent-accent: #ffffff; }
.agent-accent--code         { --agent-accent: #8be9fd; }
.agent-accent--math         { --agent-accent: #f1fa8c; }
.agent-accent--explorer     { --agent-accent: #50fa7b; }
.agent-accent--writer       { --agent-accent: #ff79c6; }
.agent-accent--debugger     { --agent-accent: #ffb86c; }
.agent-accent--secretary    { --agent-accent: #bd93f9; }

/* ── Sidebar ──────────────────────────────────────────────────────────────── */

.sidebar {
  width: 56px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 4px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  scrollbar-width: none;
}

.sidebar::-webkit-scrollbar { display: none; }

.sidebar-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  position: relative;
  transition: background 0.1s;
  border: 1px solid transparent;
  font-family: var(--font);
  font-weight: 700;
  font-size: 14px;
  color: var(--text-muted);
  user-select: none;
}

.sidebar-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.sidebar-item--active {
  border-color: var(--agent-accent, var(--text));
  color: var(--agent-accent, var(--text));
  background: var(--surface-hover);
}

.sidebar-item--home {
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.sidebar-divider {
  width: 24px;
  height: 1px;
  background: var(--border);
  margin: 4px 0;
  flex-shrink: 0;
}

.sidebar-tooltip {
  position: absolute;
  left: 54px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text);
  padding: 4px 8px;
  font-size: 11px;
  white-space: nowrap;
  border-radius: 2px;
  pointer-events: none;
  z-index: 100;
}

/* ── Agent Status Indicator ──────────────────────────────────────────────── */

.sidebar-status {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--bg);
}

.sidebar-status--idle    { background: var(--text-muted); }
.sidebar-status--busy    { background: var(--agent-accent, var(--text)); }

/* ── Agent View ───────────────────────────────────────────────────────────── */

.agent-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.agent-identity {
  padding: 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.agent-avatar {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font);
  font-weight: 700;
  font-size: 22px;
  color: var(--bg);
  background: var(--agent-accent, var(--text));
  flex-shrink: 0;
}

.agent-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.agent-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.agent-role {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-tagline {
  font-size: 10px;
  color: var(--text-muted);
  font-style: italic;
}

/* ── Agent Resources Panel ────────────────────────────────────────────────── */

.agent-resources {
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  max-height: 200px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.agent-resources-title {
  padding: 8px 16px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  user-select: none;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
}

.agent-resource-item {
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}

.agent-resource-item:last-child { border-bottom: none; }

.agent-resource-status {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  flex-shrink: 0;
}

.agent-resource-status--active  { border-color: var(--agent-accent, var(--text)); color: var(--agent-accent, var(--text)); }
.agent-resource-status--paused  { border-color: var(--text-muted); }

.agent-resource-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-resource-schedule {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.agent-resource-empty {
  padding: 12px 16px;
  font-size: 11px;
  color: var(--text-muted);
}

/* ── Agent Activity Feed ──────────────────────────────────────────────────── */

.agent-activity {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.agent-activity-title {
  padding: 8px 16px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  user-select: none;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
}

.agent-activity-item {
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.agent-activity-item:last-child { border-bottom: none; }

.agent-activity-type {
  color: var(--text);
  font-weight: 700;
}

.agent-activity-time {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 8px;
}

.agent-activity-empty {
  padding: 12px 16px;
  font-size: 11px;
  color: var(--text-muted);
}

/* ── Layout update: main now includes sidebar ─────────────────────────────── */

.main {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
}
```

**Step 2: Commit**

```bash
git add apps/web/app.css
git commit -m "style(web): add sidebar and agent-view CSS with accent colors"
```

---

### Task 4: Create Sidebar component

**Files:**
- Create: `apps/web/sidebar.tsx`

**Step 1: Write the Sidebar component**

```tsx
// apps/web/sidebar.tsx
import React, { useState } from "react";
import type { AgentInfo, ViewTarget } from "./types";
import { AGENT_PERSONALITIES } from "./types";
import { DithieSprite } from "./dithie-sprite";
import type { DithieState } from "./types";

interface SidebarProps {
  agents: AgentInfo[];
  activeView: ViewTarget;
  onSelectView: (view: ViewTarget) => void;
  dithieState: DithieState;
  busyAgents: Set<string>; // agents currently processing
}

export function Sidebar({ agents, activeView, onSelectView, dithieState, busyAgents }: SidebarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="sidebar">
      {/* Home button (Dithie / orchestrator) */}
      <div
        className={`sidebar-item agent-accent--orchestrator${activeView === "home" ? " sidebar-item--active" : ""}`}
        onClick={() => onSelectView("home")}
        onMouseEnter={() => setHoveredId("home")}
        onMouseLeave={() => setHoveredId(null)}
      >
        <DithieSprite size={32} state={dithieState} />
        {hoveredId === "home" && <div className="sidebar-tooltip">dithie (home)</div>}
      </div>

      <div className="sidebar-divider" />

      {/* Agent buttons */}
      {agents.filter(a => a.id !== "orchestrator").map((agent) => {
        const personality = AGENT_PERSONALITIES[agent.id];
        const isActive = activeView === agent.id;
        const isBusy = busyAgents.has(agent.id);

        return (
          <div
            key={agent.id}
            className={`sidebar-item agent-accent--${agent.id}${isActive ? " sidebar-item--active" : ""}`}
            onClick={() => onSelectView(agent.id)}
            onMouseEnter={() => setHoveredId(agent.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {personality?.badge ?? agent.id[0]?.toUpperCase() ?? "?"}
            <div className={`sidebar-status sidebar-status--${isBusy ? "busy" : "idle"}`} />
            {hoveredId === agent.id && (
              <div className="sidebar-tooltip">{agent.name}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Verify types**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/sidebar.tsx
git commit -m "feat(web): add Sidebar component with agent navigation"
```

---

### Task 5: Create AgentView component

**Files:**
- Create: `apps/web/agent-view.tsx`

**Step 1: Write the AgentView component**

```tsx
// apps/web/agent-view.tsx
import React, { useEffect, useState } from "react";
import type { AgentInfo, TraceEvent, ScheduledJobInfo } from "./types";
import { AGENT_PERSONALITIES } from "./types";

interface AgentViewProps {
  agent: AgentInfo;
  traces: TraceEvent[];
  jobs: ScheduledJobInfo[];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function AgentIdentity({ agent }: { agent: AgentInfo }) {
  const personality = AGENT_PERSONALITIES[agent.id];
  return (
    <div className={`agent-identity agent-accent--${agent.id}`}>
      <div className="agent-avatar">{personality?.badge ?? agent.id[0]?.toUpperCase()}</div>
      <div className="agent-meta">
        <div className="agent-name">{agent.name}</div>
        <div className="agent-role">{agent.role}</div>
        {personality && <div className="agent-tagline">"{personality.tagline}"</div>}
      </div>
    </div>
  );
}

function JobsPanel({ jobs }: { jobs: ScheduledJobInfo[] }) {
  if (jobs.length === 0) {
    return (
      <div className="agent-resources">
        <div className="agent-resources-title">SCHEDULED JOBS</div>
        <div className="agent-resource-empty">no scheduled jobs</div>
      </div>
    );
  }
  return (
    <div className="agent-resources">
      <div className="agent-resources-title">SCHEDULED JOBS ({jobs.length})</div>
      {jobs.map((job) => (
        <div key={job.jobId} className="agent-resource-item">
          <span className={`agent-resource-status agent-resource-status--${job.status}`}>
            {job.status}
          </span>
          <span className="agent-resource-label" title={job.task}>
            {job.task.length > 50 ? job.task.slice(0, 50) + "\u2026" : job.task}
          </span>
          <span className="agent-resource-schedule">
            {job.schedule.cron ?? (job.schedule.type === "once" ? "once" : `${job.schedule.delayMs}ms`)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CapabilitiesPanel({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) return null;
  return (
    <div className="agent-resources">
      <div className="agent-resources-title">CAPABILITIES</div>
      <div style={{ padding: "8px 16px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
        {capabilities.map((cap) => (
          <span key={cap} className="agent-resource-status">{cap}</span>
        ))}
      </div>
    </div>
  );
}

function ActivityFeed({ traces }: { traces: TraceEvent[] }) {
  const recentTraces = traces.slice(-50).reverse();
  return (
    <div className="agent-activity">
      <div className="agent-activity-title">ACTIVITY</div>
      {recentTraces.length === 0 && (
        <div className="agent-activity-empty">no activity yet</div>
      )}
      {recentTraces.map((t) => (
        <div key={t.eventId} className="agent-activity-item">
          <span className="agent-activity-type">{t.type}</span>
          {t.toolName && <span> {t.toolName}</span>}
          <span> — {t.status}</span>
          <span className="agent-activity-time">{formatTime(t.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

export function AgentView({ agent, traces, jobs }: AgentViewProps) {
  const agentTraces = traces.filter((t) => t.agentId === agent.id);
  const agentJobs = jobs.filter(
    (j) => j.targetAgentId === agent.id || j.createdBy === agent.id
  );

  // Show jobs panel only for agents that use scheduling (secretary)
  const showJobs = agent.id === "secretary" || agentJobs.length > 0;

  return (
    <div className={`agent-view agent-accent--${agent.id}`}>
      <AgentIdentity agent={agent} />
      <CapabilitiesPanel capabilities={agent.capabilities} />
      {showJobs && <JobsPanel jobs={agentJobs} />}
      <ActivityFeed traces={agentTraces} />
    </div>
  );
}
```

**Step 2: Verify types**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/agent-view.tsx
git commit -m "feat(web): add AgentView component with identity, resources, and activity"
```

---

### Task 6: Update reducer state for view navigation and jobs tracking

**Files:**
- Modify: `apps/web/app.tsx`

**Step 1: Update State and reducer**

Add to State interface:
```ts
activeView: ViewTarget;
jobs: ScheduledJobInfo[];
busyAgents: Set<string>;
```

Add to initialState:
```ts
activeView: "home" as ViewTarget,
jobs: [],
busyAgents: new Set<string>(),
```

Add new action types:
```ts
| { type: "set_view"; view: ViewTarget }
```

Add reducer cases:
```ts
case "set_view":
  return { ...state, activeView: action.view };

case "job_lifecycle": {
  const job = action.job as ScheduledJobInfo;
  if (!job?.jobId) return state;
  const newJobs = state.jobs.filter((j) => j.jobId !== job.jobId);
  if (job.status !== "completed" && job.status !== "failed") {
    newJobs.push(job);
  }
  return { ...state, jobs: newJobs };
}
```

Update `chat_sending` to track busy agents:
```ts
case "chat_sending": {
  const newBusy = new Set(state.busyAgents);
  newBusy.add(action.toAgentId);
  return {
    ...state,
    dithieState: "thinking",
    isStreaming: true,
    streamBuffer: "",
    currentRunId: action.runId,
    busyAgents: newBusy,
  };
}
```

Update `stream_end` and `stream_error` to clear busy agents:
```ts
// In stream_end, add:
busyAgents: new Set<string>(), // clear all on completion
```

**Step 2: Add initial jobs fetch on connect**

In the `useEffect` that handles WebSocket `onopen`, add a fetch for initial jobs:

```ts
ws.onopen = () => {
  dispatch({ type: "ws_connected" });
  // Fetch initial jobs
  fetch("/api/jobs")
    .then((r) => r.json())
    .then((jobs) => {
      for (const job of jobs) {
        dispatch({ type: "job_lifecycle", job });
      }
    })
    .catch(() => {});
};
```

**Step 3: Verify types**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): add view navigation state, jobs tracking, busy agents to reducer"
```

---

### Task 7: Wire sidebar and agent views into App layout

**Files:**
- Modify: `apps/web/app.tsx`

**Step 1: Import new components**

```ts
import { Sidebar } from "./sidebar";
import { AgentView } from "./agent-view";
```

**Step 2: Update `handleSend` to target selected agent**

```ts
const handleSend = useCallback((content: string) => {
  const ws = wsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dispatch({ type: "send_user_message", content, id });
  // Send to selected agent (home = orchestrator, otherwise direct)
  const toAgentId = state.activeView === "home" ? "orchestrator" : state.activeView;
  ws.send(JSON.stringify({ type: "chat", toAgentId, content }));
}, [state.activeView]);
```

**Step 3: Update App render to include Sidebar and conditional view**

Replace the current `<div className="main">` block:

```tsx
<div className="main">
  <Sidebar
    agents={state.agents}
    activeView={state.activeView}
    onSelectView={(view) => dispatch({ type: "set_view", view })}
    dithieState={state.dithieState}
    busyAgents={state.busyAgents}
  />
  {state.activeView === "home" ? (
    <ChatPanel state={state} dispatch={dispatch} />
  ) : (
    (() => {
      const agent = state.agents.find((a) => a.id === state.activeView);
      if (!agent) return <ChatPanel state={state} dispatch={dispatch} />;
      return (
        <AgentView
          agent={agent}
          traces={state.traces}
          jobs={state.jobs}
        />
      );
    })()
  )}
  <TracePanel
    traces={state.activeView === "home"
      ? state.traces
      : state.traces.filter((t) => t.agentId === state.activeView)}
    expandedTraces={state.expandedTraces}
    traceDurations={state.traceDurations}
    onToggleTrace={(id) => dispatch({ type: "toggle_trace", eventId: id })}
  />
</div>
```

**Step 4: Update InputBar placeholder text**

```tsx
<InputBar
  onSend={handleSend}
  disabled={state.isStreaming}
  placeholder={state.activeView === "home"
    ? "message dithie..."
    : `message ${state.agents.find(a => a.id === state.activeView)?.name ?? state.activeView}...`}
/>
```

Update InputBar to accept a `placeholder` prop:

```tsx
function InputBar({ onSend, disabled, placeholder }: {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  // ... existing code, update placeholder:
  placeholder={disabled ? "thinking..." : (placeholder ?? "message dithie...")}
```

**Step 5: Verify the full app renders**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): wire sidebar and agent views into app layout"
```

---

### Task 8: Add agentId tracking to messages for per-agent chat history

**Files:**
- Modify: `apps/web/app.tsx`

**Step 1: Track `toAgentId` in streaming state**

Add `streamingAgentId: string | null` to State (initial: `null`).

In `chat_sending`:
```ts
streamingAgentId: action.toAgentId,
```

In `stream_end`, include agentId in the message:
```ts
const msg: UIMessage = {
  ...existing,
  agentId: state.streamingAgentId ?? undefined,
};
// Also reset streamingAgentId:
streamingAgentId: null,
```

Same for `stream_error`.

In `send_user_message`, include the target agent:
```ts
// Update action type to include agentId
| { type: "send_user_message"; content: string; id: string; agentId?: string }

// In reducer, propagate:
agentId: action.agentId,
```

In `handleSend`, pass agentId:
```ts
const toAgentId = state.activeView === "home" ? "orchestrator" : state.activeView;
dispatch({ type: "send_user_message", content, id, agentId: toAgentId });
```

**Step 2: Verify types**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): track agentId in messages for per-agent chat filtering"
```

---

### Task 9: Add chat tab to AgentView for direct agent conversations

**Files:**
- Modify: `apps/web/agent-view.tsx`
- Modify: `apps/web/app.tsx`

**Step 1: Add per-agent chat to AgentView**

Add a tab bar to AgentView with two tabs: "Activity" and "Chat". The Chat tab shows messages filtered to that agent (from UIMessage.agentId).

Update AgentViewProps:
```ts
interface AgentViewProps {
  agent: AgentInfo;
  traces: TraceEvent[];
  jobs: ScheduledJobInfo[];
  messages: UIMessage[];
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
}
```

Add a simple tab state inside AgentView:
```tsx
const [tab, setTab] = useState<"activity" | "chat">("activity");
const agentMessages = messages.filter((m) => m.agentId === agent.id);
```

Render tab bar + conditional content. The "Chat" tab renders the same MessageBubble/StreamingBubble components (import them or pass as children).

**Step 2: Pass extra props from App**

In `app.tsx`, update the AgentView usage to pass messages, streaming state.

**Step 3: Verify**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/agent-view.tsx apps/web/app.tsx
git commit -m "feat(web): add chat tab to agent view for direct conversations"
```

---

### Task 10: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Step 1: Update all three docs**

Add to the "Web UI" or "Dithie Dashboard" section in each:

- New sidebar navigation with per-agent views
- Agent personality system (accent colors, badges, taglines)
- Per-agent activity feed and resource panels
- Direct agent messaging from agent views
- `/api/agents/:id/activity` endpoint

Update the "Files" section to include new files:
- `apps/web/types.ts`
- `apps/web/sidebar.tsx`
- `apps/web/agent-view.tsx`

**Step 2: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: update docs for per-agent views UI redesign"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Extract shared types | `types.ts` (new), `app.tsx` |
| 2 | Add activity REST endpoint | `server.ts` |
| 3 | Add sidebar + agent-view CSS | `app.css` |
| 4 | Create Sidebar component | `sidebar.tsx` (new) |
| 5 | Create AgentView component | `agent-view.tsx` (new) |
| 6 | Update reducer for views/jobs | `app.tsx` |
| 7 | Wire sidebar + views into App | `app.tsx` |
| 8 | Track agentId on messages | `app.tsx` |
| 9 | Add chat tab to AgentView | `agent-view.tsx`, `app.tsx` |
| 10 | Update documentation | `README.md`, `CLAUDE.md`, `AGENTS.md` |
