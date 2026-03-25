# Dithie Frontend — Design Spec

## Overview

A desktop-only web dashboard for the pi-agent multi-agent runtime, replacing the existing prototype in `apps/web/`. The UI is a modern CLI-aesthetic split-view with a monocromatic black-and-white palette, centered around "Dithie" — a pixel-art spider character that serves as the orchestrator's visual identity.

## Stack

- **Runtime:** Bun HTML imports + `Bun.serve()` (existing `apps/backend/server.ts`)
- **Framework:** React (TSX, bundled by Bun automatically)
- **Styling:** CSS vanilla with custom properties (no Tailwind, no component library)
- **WebSocket:** Existing bidirectional protocol (extended with delegation events)
- **Font:** JetBrains Mono via Google Fonts CDN (`<link>` in `index.html`)
- **Target:** Desktop-only, modern browsers

## Palette

Pure monochromatic. No per-agent colors. Differentiation comes from text labels and structure.

```css
:root {
  --bg:             #000000;   /* main background */
  --surface:        #0a0a0a;   /* panels, cards */
  --surface-hover:  #141414;   /* hover states */
  --border:         #1f1f1f;   /* subtle borders */
  --border-strong:  #333333;   /* emphasized borders */
  --text:           #ffffff;   /* primary text */
  --text-secondary: #a0a0a0;   /* secondary text */
  --text-muted:     #555555;   /* disabled/tertiary text */
  --accent:         #ffffff;   /* buttons, focus, Dithie */
  --font:           'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
}
```

Typography:
- 13px base for content
- 11px for meta/labels
- 10px for timestamps
- `letter-spacing: 0.04em` on uppercase labels

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  HEADER (48px)                                          │
│  [Dithie 32px + state]              session: xxx  [ws]  │
├───────────────────────────────────────┬─────────────────┤
│  CHAT PANEL (flex: 1)                │  TRACE PANEL     │
│                                      │  (280px fixed)   │
│  messages + delegation blocks        │  expandable items │
│                                      │                  │
├───────────────────────────────────────┴─────────────────┤
│  INPUT BAR (56px)                                       │
│  >_ [input field                              ] [Enter] │
└─────────────────────────────────────────────────────────┘
```

### Header (48px)

- **Left:** Dithie sprite (32x32) + "dithie" label + state text (idle/thinking/delegating/error)
- **Right:** Session ID display + WebSocket connection indicator (connected/disconnected)
- Background: `--surface`, bottom border: `--border`

### Chat Panel (flex: 1, left side)

Single conversational flow with Dithie. All interaction goes through Dithie — specialists are visible only via delegation blocks.

#### User messages
- Aligned right
- Right border: 2px solid white
- Label: `you` in 10px uppercase above
- Background: `--surface`

#### Dithie messages
- Aligned left
- Left border: 2px solid white
- Dithie sprite mini (16x16) as avatar to the left
- Label: `dithie` in 10px uppercase above
- Background: `--surface`

#### Delegation blocks (inline, collapsible)

Collapsed (default):
```
┌─ ▸ dithie → math ─────────────────────── 1.2s ─┐
│   "calculate the integral of x^2"               │
└─────────────────────────────────────────────────┘
```

Expanded (on click):
```
┌─ ▾ dithie → math ─────────────────────── 1.2s ─┐
│   task: "calculate the integral of x^2"         │
│   ─────────────────────────────────────────────  │
│   result: "x^3/3 + C"                           │
└─────────────────────────────────────────────────┘
```

- Border: `1px dashed var(--border-strong)`
- Text: `--text-secondary`
- Chevron toggles `▸` / `▾`

#### Streaming
- Block cursor `▊` blinks at end of text while streaming
- Blink animation: 0.6s interval, opacity toggle

#### Empty state
- Dithie sprite (larger, 64x64) centered with "send a message to start" below in `--text-muted`

### Trace Panel (280px, right side)

Real-time activity feed. Separated from chat by `--border` vertical line.

#### Panel header
- `TRACES` in 10px uppercase, `--text-muted`
- Bottom border separator

#### Trace items — collapsed (default)

```
tool_start              running
  └ orchestrator
```

- Primary line: type (left) + status (right-aligned)
- Secondary line: indented agentId if present
- Left border: 2px `--border-strong`

#### Trace items — expanded (on click)

```
▾ tool_start            running
  agent: orchestrator
  chatId: abc-123
  toolCallId: tc_456
  duration: 1.2s
  ──────────────────
  details:
    toolName: delegate
    task: "calculate..."
```

- Key-value pairs, YAML-like indented format (not raw JSON)
- Left border: 2px white (emphasis on expanded)
- Chevron `▾` indicates expanded state

#### Status indicators (text-only, no color)
- `running` → white text
- `ok` → white text + `✓` prefix
- `error` → white text + `✗` prefix
- `queued` → muted text (`--text-muted`)
- `cancelled` → muted text + strikethrough

#### Scroll behavior
- Traces are displayed **newest-last** (append to bottom) — reversed from the current prototype which is newest-first
- Auto-scroll to latest trace when user is within 50px of the bottom
- Stops auto-scroll if user scrolls up beyond that threshold
- Resumes auto-scroll when user scrolls back to within 50px of the bottom

### Input Bar (56px)

- Terminal-style prompt: `>_` prefix in `--text-muted`
- Input field: full width, `--bg` background, `--border` border
- Focus state: border becomes `--accent` (white)
- No visible send button — Enter to send (keyboard-first)
- Disabled state: shows animated `...` when Dithie is processing
- Background: `--surface`, top border: `--border`

## Dithie — Pixel Art Spider Character

### Design

A front-facing pixel-art spider rendered as a CSS Grid. Square body, two large eyes (2x2 pixels each) with pupils looking directly at the user, 4 pairs of angular legs extending to the sides.

### Rendering

- Grid data defined as 2D arrays in TypeScript (one per animation frame)
- **16x16 and 32x32:** CSS Grid where each cell = 1 `<div>` pixel. Efficient at these sizes (256 / 1024 DOM nodes).
- **64x64 (empty state only):** Rendered on `<canvas>` to avoid 4096 DOM nodes. The canvas draws from the same frame data arrays, scaled up.
- Colors: white pixels on black background (or inverted for light contexts)
- No external assets — everything generated in code

### Animation States

| State | Eyes | Legs | Animation |
|-------|------|------|-----------|
| **Idle** | Centered pupils, blink every ~3s (pupils off for 150ms) | Symmetric, still | Subtle 1px vertical "breathing" (1.5s cycle) |
| **Thinking** | Pupils move: up-left, center, up-right, center (loop) | Front pair taps alternately | Tap rhythm ~0.5s per leg |
| **Delegating** | Pupils look toward trace panel (right) | Legs extend outward (wider posture) | Smooth extend over 0.3s, hold |
| **Error** | Pupils become X X pattern | Legs contract inward (huddle) | Quick contract 0.2s, stays |

### State mapping

Dithie's visual state is derived from the runtime's WebSocket messages:

- `idle` → no active streaming, no pending chats
- `thinking` → `chat_sending` received, streaming in progress
- `delegating` → `delegation_start` received
- `error` → `stream_error` received (resets to idle after 3s)

## WebSocket Protocol

The existing protocol is extended with two new message types for delegation tracking. All existing messages remain unchanged.

**New messages (server → client):**

```ts
// Emitted when the orchestrator delegates to a specialist
{ type: "delegation_start", runId: string, delegationId: string, fromAgentId: string, toAgentId: string, task: string }

// Emitted when the delegation completes (or fails)
{ type: "delegation_end", runId: string, delegationId: string, result: string, durationMs: number, status: "ok" | "error" }
```

The `delegationId` correlates start and end events. It is derived from the `chatId` created by the delegation tool call. The backend emits `delegation_start` when it detects a `tool_execution_start` for `delegate`/`delegate_task`, and `delegation_end` when the corresponding chat completes or fails.

**All inbound messages (server → client):**
- `agents` — agent list on connect
- `chat_sending` — triggers thinking state
- `stream_delta` — appends to streaming buffer
- `stream_end` — finalizes message
- `stream_error` — shows error, triggers error state
- `stream_status` — text status labels (retained for non-delegation status)
- `delegation_start` — **NEW** starts a delegation block + triggers delegating state
- `delegation_end` — **NEW** completes a delegation block
- `trace` — trace panel feed
- `chat_lifecycle` — future use
- `hitl_request` — HITL approval modal (future)
- `job_lifecycle` — future use

**Outbound (client → server):**
- `{ type: "chat", toAgentId: "orchestrator", content }` — always targets orchestrator
- `{ type: "hitl_response", reqId, approved }` — future HITL support

**Key difference from current UI:** The frontend always sends to `"orchestrator"` (Dithie). No agent switching in the UI. Delegation is Dithie's job.

**Backend changes required:** `apps/backend/server.ts` must emit `delegation_start` and `delegation_end` in the `onAgentEvent` callback, extracting structured data from `tool_execution_start` (for delegate tools) and the subsequent chat result.

## Component Architecture

```
App
├── Header
│   ├── DithieSprite (32px, animated)
│   ├── StateLabel
│   └── SessionInfo
├── MainPanel
│   ├── ChatPanel
│   │   ├── EmptyState (DithieSprite 64px)
│   │   ├── MessageBubble (user)
│   │   ├── MessageBubble (dithie, with DithieSprite 16px avatar)
│   │   ├── DelegationBlock (collapsible)
│   │   └── StreamingBubble (with block cursor)
│   └── TracePanel
│       ├── TracePanelHeader
│       └── TraceItem (collapsible)
└── InputBar
    └── TerminalInput
```

### State management

Same `useReducer` pattern as current prototype. Changes:
- Remove `activeAgent` (always orchestrator)
- Remove `AGENT_COLORS`
- Add `dithieState: "idle" | "thinking" | "delegating" | "error"`
- Add `delegations: Record<string, DelegationBlock>` for tracking delegation events
- Add `expandedTraces: Set<string>` for trace panel expand/collapse
- Add `expandedDelegations: Set<string>` for delegation block expand/collapse

### DelegationBlock type

```ts
interface DelegationBlock {
  delegationId: string;       // correlates start/end (derived from chatId)
  fromAgentId: string;        // always "orchestrator" for now
  toAgentId: string;          // specialist agent
  task: string;               // delegation task text
  result?: string;            // filled on delegation_end
  status: "running" | "ok" | "error";
  durationMs?: number;        // filled on delegation_end
}
```

### Trace duration computation

The `TraceEvent` interface has no `duration` field. Duration is computed client-side by pairing `tool_start` and `tool_end` events sharing the same `toolCallId`. For chat-level duration, pair `chat_created` and `chat_completed`/`chat_failed` events by `chatId`. The trace panel stores a `Map<string, number>` of `toolCallId → startTimestamp` to compute elapsed time on end events.

### DithieSprite component

```tsx
interface DithieSpriteProps {
  size: 16 | 32 | 64;
  state: "idle" | "thinking" | "delegating" | "error";
}
```

Renders a CSS Grid where each cell is a colored div. Frame data is a `number[][]` (0 = transparent, 1 = filled). Animation frames cycle via `useEffect` + `setInterval`.

## Files to create/modify

### New files
- `apps/web/app.tsx` — complete rewrite
- `apps/web/app.css` — complete rewrite
- `apps/web/dithie-sprite.tsx` — sprite component + frame data + animation logic

### Modified files
- `apps/web/index.html` — update `<title>` to "dithie", add JetBrains Mono `<link>` from Google Fonts CDN
- `apps/backend/server.ts` — emit `delegation_start` and `delegation_end` WebSocket messages from `onAgentEvent` callback

### Unchanged
- `packages/core/*` — no runtime changes
- `apps/cli/*` — CLI untouched

## Out of scope

- Mobile/responsive layout
- WhatsApp integration (separate feature)
- HITL approval UI (future — spec notes where it fits)
- Agent switching/direct specialist chat
- Light mode / theme toggle
- Sound effects / notifications
