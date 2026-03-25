# Dithie Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a B&W desktop dashboard for the pi-agent runtime, replacing the existing prototype, with Dithie (pixel-art spider) as the orchestrator identity.

**Architecture:** Rewrite `apps/web/` (React + CSS + Bun HTML imports) with a split-view layout (Chat | Traces), monocromatic palette, and a pixel-art spider sprite with animated states. Extend `apps/backend/server.ts` to emit structured delegation events. No runtime (`packages/core`) changes.

**Tech Stack:** Bun HTML imports, React 18, CSS custom properties, WebSocket (existing protocol + 2 new message types)

**Spec:** `docs/superpowers/specs/2026-03-24-dithie-frontend-design.md`

---

## File Structure

```
apps/web/
├── index.html             — MODIFY: title "dithie", add JetBrains Mono font link
├── app.tsx                — REWRITE: App shell, useReducer state, WebSocket, all components
├── app.css                — REWRITE: B&W palette, layout, all component styles
├── dithie-sprite.tsx      — CREATE: DithieSprite component, frame data, animations
└── dithie-frames.ts       — CREATE: Pixel grid data for all animation frames (extracted for testability)

apps/backend/
└── server.ts              — MODIFY: add delegation_start/delegation_end WS messages
```

**Why `dithie-frames.ts` is separate:** The frame data arrays are pure data (no React dependency) and can be unit-tested independently. `dithie-sprite.tsx` imports them and handles rendering + animation.

---

## Task 1: CSS Foundation — Palette & Layout Shell

**Files:**
- Rewrite: `apps/web/app.css`
- Modify: `apps/web/index.html`

This task creates the visual foundation. No React — just the CSS vars, layout grid, and HTML shell.

- [ ] **Step 1: Update `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>dithie</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="./app.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.tsx"></script>
</body>
</html>
```

- [ ] **Step 2: Write `app.css` with palette, reset, and layout**

Complete CSS with all custom properties from spec, layout grid (header 48px, main flex, input 56px), chat panel (flex:1), trace panel (280px fixed). Include all component styles: messages (user right-aligned, dithie left-aligned, delegation blocks dashed border), trace panel (collapsed/expanded items, status indicators), input bar (terminal prompt), header, empty state, streaming cursor, animations (blink cursor, breathing).

Key CSS vars from spec:
```css
:root {
  --bg: #000000;
  --surface: #0a0a0a;
  --surface-hover: #141414;
  --border: #1f1f1f;
  --border-strong: #333333;
  --text: #ffffff;
  --text-secondary: #a0a0a0;
  --text-muted: #555555;
  --accent: #ffffff;
  --font: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  --header-h: 48px;
  --input-h: 56px;
  --trace-w: 280px;
}
```

Key animations to include:
- `@keyframes blink-cursor` — 0.6s opacity toggle for streaming `▊`
- `@keyframes breathe` — 1.5s translateY(1px) for Dithie idle
- `@keyframes dot-pulse` — 1s opacity pulse for `...` waiting indicator

- [ ] **Step 3: Verify layout renders**

Run: `bun run ui -- --session test-dithie`

Open `http://localhost:3000`. Should see black background, empty layout structure (header area, split panels, input bar). Font should be JetBrains Mono.

- [ ] **Step 4: Commit**

```bash
git add apps/web/index.html apps/web/app.css
git commit -m "feat(web): B&W CSS foundation with layout grid and palette"
```

---

## Task 2: Dithie Sprite — Frame Data & Rendering

**Files:**
- Create: `apps/web/dithie-frames.ts`
- Create: `apps/web/dithie-sprite.tsx`

- [ ] **Step 1: Write `dithie-frames.ts` — pixel grid data**

Define the spider sprite as `number[][]` arrays (0 = transparent, 1 = filled). The spider is front-facing, square body, 2 large eyes (2x2 each) with pupils, 4 pairs of angular legs.

Export these named frames:
- `FRAME_IDLE` — base pose, pupils centered, legs symmetric
- `FRAME_IDLE_BLINK` — same as idle but pupils replaced with 0 (eyes closed)
- `FRAME_THINKING_1` through `FRAME_THINKING_4` — pupils shift up-left, center, up-right, center; front legs alternate tap
- `FRAME_DELEGATING` — pupils shifted right, legs extended outward
- `FRAME_ERROR` — pupils become X pattern, legs contracted inward

All frames must be the same dimensions (use 16x16 grid — gives enough room for body + 2x2 eyes + 4 pairs of angular legs). Each frame is a `number[][]` where `frame[row][col]`.

Here's a rough ASCII reference for `FRAME_IDLE` (16x16, `#` = filled, `.` = transparent):

```
................
..#.........#..
...#.......#...
..#.#######.#..
.#.##.#.#.##.#.
...##.....##...
.#.##.###.##.#.
..#.#######.#..
...#.#####.#...
.#.#.#####.#.#.
#..#.#####.#..#
...#..###..#...
..#...###...#..
.#.....#.....#.
#..............#
................
```

Eyes: two 2x2 blocks in rows 5-6, cols 6-7 and 9-10 (pupils = filled center pixels). Legs: angular lines extending from body corners outward. This is a starting reference — adjust as needed for visual quality.

Export type: `export type Frame = number[][];`

- [ ] **Step 2: Write `dithie-sprite.tsx` — CSS Grid renderer + canvas renderer**

```tsx
interface DithieSpriteProps {
  size: 16 | 32 | 64;
  state: "idle" | "thinking" | "delegating" | "error";
}
```

Logic:
- For `size` 16 or 32: render CSS Grid. Each cell is a `<div>` with `background: white` (filled) or `transparent`. Grid dimensions from frame data. Cell size = `size / gridRows`.
- For `size` 64: render `<canvas>` element. Use `useRef` + `useEffect` to draw pixels from frame data, scaled up.
- Animation: `useEffect` + `setInterval` to cycle frames based on `state`:
  - `idle`: show `FRAME_IDLE`, blink every 3s (swap to `FRAME_IDLE_BLINK` for 150ms). CSS `breathe` animation on wrapper.
  - `thinking`: cycle `FRAME_THINKING_1..4` at 500ms intervals.
  - `delegating`: show `FRAME_DELEGATING` static.
  - `error`: show `FRAME_ERROR` static.

- [ ] **Step 3: Test sprite renders at all sizes**

Temporarily render `<DithieSprite size={32} state="idle" />` in the app. Verify the spider shows white pixels on black, blinks, and is recognizable as a front-facing spider.

Check sizes: 16px (small avatar), 32px (header), 64px (empty state).

- [ ] **Step 4: Commit**

```bash
git add apps/web/dithie-frames.ts apps/web/dithie-sprite.tsx
git commit -m "feat(web): Dithie pixel-art spider sprite with animation states"
```

---

## Task 3: App State — useReducer Rewrite

**Files:**
- Rewrite: `apps/web/app.tsx` (state layer only — no rendering yet)

- [ ] **Step 1: Define types and interfaces**

In `app.tsx`, define:

```tsx
interface DelegationBlock {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  result?: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
}

type DithieState = "idle" | "thinking" | "delegating" | "error";

interface UIMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
  runId?: string;
  durationMs?: number;
}

type ChatItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "delegation"; delegationId: string };

interface State {
  agents: AgentInfo[];
  sessionId: string;
  messages: UIMessage[];
  chatItems: ChatItem[];              // unified timeline for rendering chat flow
  isStreaming: boolean;
  streamBuffer: string;
  currentRunId: string | null;
  dithieState: DithieState;
  traces: TraceEvent[];
  delegations: Record<string, DelegationBlock>;
  traceStartTimes: Record<string, number>;  // toolCallId/chatId → timestamp for duration calc
  traceDurations: Record<string, number>;   // toolCallId/chatId → duration ms
  expandedTraces: Set<string>;
  expandedDelegations: Set<string>;
  wsConnected: boolean;
}
```

Also define `ServerMsg` type — include ALL existing variants plus the two new ones:
```tsx
type ServerMsg =
  | { type: "agents"; agents: AgentInfo[]; sessionId?: string }
  | { type: "chat_sending"; runId: string; toAgentId: string }
  | { type: "stream_delta"; runId: string; delta: string }
  | { type: "stream_end"; runId: string; answer: string; durationMs: number }
  | { type: "stream_error"; runId: string; error: string }
  | { type: "stream_status"; runId: string; text: string }   // silently ignored — behavioral change from old UI which showed these as messages
  | { type: "trace"; event: TraceEvent }
  | { type: "chat_lifecycle"; chat: unknown }
  | { type: "delegation_start"; runId: string; delegationId: string; fromAgentId: string; toAgentId: string; task: string }
  | { type: "delegation_end"; runId: string; delegationId: string; result: string; durationMs: number; status: "ok" | "error" };
```

And `LocalAction`:
```tsx
type LocalAction =
  | { type: "send_user_message"; content: string; id: string }
  | { type: "toggle_trace"; eventId: string }
  | { type: "toggle_delegation"; delegationId: string }
  | { type: "reset_dithie_state" }
  | { type: "ws_connected" }
  | { type: "ws_disconnected" };
```

**Note:** `stream_status` is intentionally ignored in the new reducer. The old UI rendered these as visible status messages. The new UI replaces that with structured `DelegationBlock` components fed by `delegation_start`/`delegation_end`. Non-delegation status labels are dropped.

- [ ] **Step 2: Write reducer**

Key differences from current prototype:
- No `activeAgent` — always orchestrator. Remove `AgentBar`, `switch_agent`, and message filtering by agent.
- No `AGENT_COLORS` — everything is B&W
- `stream_status` → no-op (see note above)

**Dithie state machine** (complete transition rules):
```
idle → thinking        (on chat_sending)
thinking → delegating  (on delegation_start)
thinking → idle        (on stream_end)
thinking → error       (on stream_error)
delegating → thinking  (on delegation_end, if isStreaming is still true)
delegating → idle      (on delegation_end, if isStreaming is false)
delegating → error     (on stream_error)
error → idle           (on reset_dithie_state, fired by 3s setTimeout in component)
```

Reducer cases:
- `chat_sending` → `dithieState: "thinking"`, `isStreaming: true`
- `stream_delta` → append to `streamBuffer`
- `stream_end` → create message, push to `messages` AND `chatItems`, set `dithieState: "idle"`, `isStreaming: false`
- `stream_error` → create error message, push to `messages` AND `chatItems`, set `dithieState: "error"`, `isStreaming: false`
- `send_user_message` → create user message, push to `messages` AND `chatItems`
- `delegation_start` → create `DelegationBlock` in `delegations`, push `{ kind: "delegation", delegationId }` to `chatItems`, set `dithieState: "delegating"`
- `delegation_end` → update `DelegationBlock` (result, status, durationMs). Set `dithieState: isStreaming ? "thinking" : "idle"`
- `trace` → append newest-last (`[...state.traces, event]`), cap at 200. Compute durations: on `tool_start`/`chat_created` save timestamp to `traceStartTimes[toolCallId/chatId]`. On `tool_end`/`chat_completed`/`chat_failed` compute diff and store in `traceDurations`.
- `toggle_trace` / `toggle_delegation` → toggle Set membership
- `reset_dithie_state` → `dithieState: "idle"`
- `ws_connected` / `ws_disconnected` → update `wsConnected`
- `agents` → store agents + extract `sessionId` if present

- [ ] **Step 3: Write WebSocket hook**

`useWebSocket` custom hook that:
- Connects to `ws://${location.host}/ws`
- Dispatches parsed messages to reducer
- Dispatches `ws_connected` / `ws_disconnected`
- Returns `{ send, connected }` — `send` always targets orchestrator

- [ ] **Step 4: Verify state logic with console**

Boot the app, open devtools. Send a message via console `ws.send(...)` and verify state updates correctly in React DevTools or via `console.log` in reducer.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): useReducer state with delegation tracking and Dithie states"
```

---

## Task 4: UI Components — Header, InputBar, EmptyState

**Files:**
- Modify: `apps/web/app.tsx`

These are the simplest components. Build them first.

- [ ] **Step 1: Write Header component**

```tsx
function Header({ dithieState, sessionId, wsConnected }: {
  dithieState: DithieState;
  sessionId: string;
  wsConnected: boolean;
}) { ... }
```

Left: `<DithieSprite size={32} state={dithieState} />` + "dithie" label + state text.
Right: `session: {sessionId}` + WS indicator (● connected / ○ disconnected).

- [ ] **Step 2: Write InputBar component**

Terminal prompt `>_` prefix. Input field. No visible button. Enter to send. Disabled state shows `...` animation.

```tsx
function InputBar({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) { ... }
```

- [ ] **Step 3: Write EmptyState component**

`<DithieSprite size={64} state="idle" />` centered, "send a message to start" below in muted text.

- [ ] **Step 4: Wire into App shell**

Render `<Header>`, the split layout `<div className="main">`, and `<InputBar>`. The main area is empty for now (or shows EmptyState).

- [ ] **Step 5: Verify visually**

Run: `bun run ui -- --session test-dithie`

Should see: black screen, header with Dithie sprite + "dithie" label, empty state with large Dithie sprite, input bar with `>_` prompt. All white-on-black.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): Header, InputBar, and EmptyState components"
```

---

## Task 5: UI Components — Chat Panel (Messages + Streaming)

**Files:**
- Modify: `apps/web/app.tsx`

- [ ] **Step 1: Write MessageBubble component**

Two variants based on role:
- User: right-aligned, right border white, label "you" uppercase
- Assistant (Dithie): left-aligned, left border white, `<DithieSprite size={16} state="idle" />` avatar, label "dithie" uppercase

```tsx
function MessageBubble({ msg }: { msg: UIMessage }) { ... }
```

- [ ] **Step 2: Write StreamingBubble component**

Same as Dithie message but with animated block cursor `▊` at end. Content from `streamBuffer`.

- [ ] **Step 3: Write DelegationBlock component**

Collapsible inline block. Collapsed: `▸ dithie → {agent}: "{task preview}" {duration}`. Expanded: shows task + result. Dashed border. Click toggles via `toggle_delegation` dispatch.

```tsx
function DelegationBlock({ delegation, expanded, onToggle }: {
  delegation: DelegationBlock;
  expanded: boolean;
  onToggle: () => void;
}) { ... }
```

- [ ] **Step 4: Write ChatPanel component**

Renders messages interspersed with delegation blocks (by timestamp/order). Shows EmptyState when no messages. Auto-scroll to bottom.

The chat flow uses `chatItems` (defined in Task 3 State interface). `ChatPanel` iterates `chatItems` and renders either a `MessageBubble` (for `kind: "message"`) or a `DelegationBlock` (for `kind: "delegation"`, looking up data from `state.delegations[delegationId]`).

The `messages` array in state is kept for direct message lookup. `chatItems` is the rendering timeline — it determines the visual order. Both are updated in the reducer simultaneously (see Task 3 reducer cases).

- [ ] **Step 5: Verify chat flow**

Run: `bun run ui -- --session test-dithie`

Send a message. Should see user message on the right, streaming response with `▊` cursor, then final Dithie message on the left. All B&W, JetBrains Mono, terminal aesthetic.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): ChatPanel with messages, streaming, and delegation blocks"
```

---

## Task 6: UI Components — Trace Panel

**Files:**
- Modify: `apps/web/app.tsx`

- [ ] **Step 1: Write TraceItem component**

Collapsed (default): type + status on one line, agentId indented below. Left border `--border-strong`.
Expanded (on click): YAML-like key-value details. Left border white.

Status prefixes: `✓` (ok), `✗` (error), plain (running), muted (queued/cancelled with strikethrough for cancelled).

Duration: compute client-side. Store a `traceStartTimes: Record<string, number>` in state (keyed by `toolCallId` or `chatId`). On `tool_start` / `chat_created` → save timestamp. On `tool_end` / `chat_completed` → compute diff.

```tsx
function TraceItem({ trace, expanded, duration, onToggle }: {
  trace: TraceEvent;
  expanded: boolean;
  duration?: number;
  onToggle: () => void;
}) { ... }
```

- [ ] **Step 2: Write TracePanel component**

Header: "TRACES" in uppercase muted. List of `TraceItem`s ordered newest-last. Auto-scroll with 50px threshold logic.

```tsx
function TracePanel({ traces, expandedTraces, traceDurations, onToggleTrace }: {
  traces: TraceEvent[];
  expandedTraces: Set<string>;
  traceDurations: Record<string, number>;
  onToggleTrace: (eventId: string) => void;
}) { ... }
```

Auto-scroll logic: `useRef` on the scroll container + `useEffect` that checks `scrollHeight - scrollTop - clientHeight < 50` before scrolling.

- [ ] **Step 3: Verify trace panel**

Run: `bun run ui -- --session test-dithie`

Send a message. Traces should appear in the right panel, newest at the bottom. Click to expand, see YAML-like details. Status indicators should show ✓/✗ prefixes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): TracePanel with expandable items and auto-scroll"
```

---

## Task 7: Backend — Delegation Events

**Files:**
- Modify: `apps/backend/server.ts`

**Approach:** Use the `appendTrace` monkey-patch (already in `server.ts`). When a `tool_start` trace fires for `delegate`/`delegate_task`, emit `delegation_start`. When the matching `tool_end` trace fires (same `toolCallId`), emit `delegation_end`. Use `toolCallId` as the `delegationId`. This avoids needing to correlate chatIds across systems.

- [ ] **Step 1: Add delegation tracking map at module scope**

```tsx
// At module scope in server.ts, after the existing monkey-patches:
const delegationStarts = new Map<string, {
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  timestamp: number;
}>();
```

- [ ] **Step 2: Extend the `appendTrace` monkey-patch**

Replace the existing `appendTrace` monkey-patch with:

```tsx
(runtime.store as any).appendTrace = async (event: TraceEvent) => {
  await _appendTrace(event);
  broadcast({ type: "trace", event });

  // Delegation tracking: emit delegation_start on tool_start for delegate tools
  if (
    event.type === "tool_start" &&
    event.toolCallId &&
    (event.toolName === "delegate" || event.toolName === "delegate_task")
  ) {
    const details = event.details as Record<string, unknown> | undefined;
    const info = {
      runId: event.runId,
      fromAgentId: event.agentId ?? "orchestrator",
      toAgentId: String(details?.agentId ?? "unknown"),
      task: String(details?.task ?? ""),
      timestamp: event.timestamp,
    };
    delegationStarts.set(event.toolCallId, info);
    broadcast({
      type: "delegation_start",
      runId: info.runId,
      delegationId: event.toolCallId,
      fromAgentId: info.fromAgentId,
      toAgentId: info.toAgentId,
      task: info.task,
    });
  }

  // Delegation tracking: emit delegation_end on tool_end for matching toolCallId
  if (
    event.type === "tool_end" &&
    event.toolCallId &&
    delegationStarts.has(event.toolCallId)
  ) {
    const start = delegationStarts.get(event.toolCallId)!;
    delegationStarts.delete(event.toolCallId);
    const details = event.details as Record<string, unknown> | undefined;
    broadcast({
      type: "delegation_end",
      runId: start.runId,
      delegationId: event.toolCallId,
      result: String(details?.result ?? ""),
      durationMs: event.timestamp - start.timestamp,
      status: event.status === "ok" ? "ok" : "error",
    });
  }
};
```

- [ ] **Step 3: Add `sessionId` to the WS `agents` message**

In the `websocket.open` handler, include `sessionId`:

```tsx
ws.send(JSON.stringify({ type: "agents", agents: runtime.listAgents(), sessionId }));
```

- [ ] **Step 4: Test with a real delegation**

Run: `bun run ui -- --session test-delegation`

Send a message that triggers delegation (e.g., "what is 2+2" should delegate to math). Verify:
1. `delegation_start` WS message arrives with correct fromAgent/toAgent/task
2. `delegation_end` WS message arrives with result and duration
3. Chat panel shows a collapsible delegation block
4. Dithie sprite transitions: idle → thinking → delegating → idle

- [ ] **Step 5: Commit**

```bash
git add apps/backend/server.ts
git commit -m "feat(server): emit delegation_start/delegation_end WebSocket events"
```

---

## Task 8: Dithie State Error Reset & Polish

**Files:**
- Modify: `apps/web/app.tsx`

- [ ] **Step 1: Error state auto-reset**

In the App component, when `dithieState` changes to `"error"`, start a 3s timeout that dispatches a reset to `"idle"`:

```tsx
useEffect(() => {
  if (state.dithieState === "error") {
    const timer = setTimeout(() => dispatch({ type: "reset_dithie_state" }), 3000);
    return () => clearTimeout(timer);
  }
}, [state.dithieState]);
```

Add `reset_dithie_state` to the reducer → sets `dithieState: "idle"`.

- [ ] **Step 2: Focus management**

After sending a message, return focus to the input field. In InputBar, use `useRef` on the input and call `.focus()` after clearing the value.

- [ ] **Step 3: Final visual review**

Run: `bun run ui -- --session final-review`

Check all states:
- Empty state shows large Dithie centered
- Typing shows `>_` prompt with cursor
- Sending shows user message right-aligned
- Streaming shows `▊` blink cursor
- Delegation shows collapsible block inline
- Traces appear in right panel, expandable
- Header shows Dithie with correct state label
- All text is JetBrains Mono, all colors are B&W/grey

- [ ] **Step 4: Commit**

```bash
git add apps/web/app.tsx
git commit -m "feat(web): error reset, focus management, polish"
```

---

## Task 9: Cleanup & Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update README.md**

Add Dithie frontend section:
- How to run: `bun run ui -- --session <id>`
- URL: `http://localhost:3000`
- Note the B&W aesthetic and Dithie character
- WebSocket protocol additions (delegation_start/delegation_end)

- [ ] **Step 2: Update CLAUDE.md**

Update the "Web UI" section:
- Replace the old color scheme description (orchestrator=purple, code=green, math=amber) with B&W palette
- Note Dithie as orchestrator identity
- Update file descriptions (new files: `dithie-sprite.tsx`, `dithie-frames.ts`)
- Update WebSocket protocol table with new message types

- [ ] **Step 3: Update AGENTS.md**

If AGENTS.md references the old UI, update references to reflect Dithie branding and B&W aesthetic. Per project guardrails, all three docs must stay in sync.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: update README, CLAUDE.md, and AGENTS.md for Dithie frontend"
```
