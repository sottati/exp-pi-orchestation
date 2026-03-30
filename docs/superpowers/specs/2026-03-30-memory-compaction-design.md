# Memory & Compaction Design

**Date:** 2026-03-30
**Status:** Approved

## Context

The runtime runs as a single persistent session — agents live permanently on a server and users communicate via WhatsApp (never via UI). This means:

- Conversation threads grow indefinitely with no natural session boundary.
- `chats.jsonl` currently stores the full chat record (including all messages) on every state change — O(n²) growth.
- `traces.jsonl` grows without bound in a single long-running process.
- Agents have no cross-session memory; each conversation starts from scratch.

This design introduces two independent improvements:

1. **Engram memory layer** — semantic cross-session memory via HTTP to a local engram service.
2. **Storage cleanup** — compaction for chat threads, O(n²) fix for `chats.jsonl`, size-based rotation for `traces.jsonl`.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────┐
│  JSONL (audit log — trazabilidad, debugging)       │
│  traces.jsonl    → rotación a 5.000 líneas         │
│  chats.jsonl     → full record solo en "closed"    │
│  threads/*.jsonl → sin cambios                     │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│  Engram (memoria semántica — cross-session)        │
│  ~/.engram/engram.db  (SQLite FTS5)                │
│  ← agentes guardan observaciones relevantes        │
│  ← resúmenes de compactación van aquí              │
│  ← recuperados por relevancia, no por orden        │
└────────────────────────────────────────────────────┘
```

Las dos capas son ortogonales:
- JSONL = "qué pasó" (audit, replay, debugging)
- Engram = "qué aprendimos" (contexto semántico futuro)

---

## Part 1: Engram Memory Layer

### New files

- `packages/core/memory-client.ts` — HTTP client for engram REST API (`http://localhost:7437`)
- `packages/core/memory-tools.ts` — tool entries: `mem_save`, `mem_get`

### Tool interface

```typescript
// mem_save — agent decides what's worth persisting
{
  title: string,
  type: "decision" | "preference" | "pattern" | "bug" | "architecture" | "conversation_summary",
  what: string,     // what happened
  why: string,      // why it matters
  where?: string,   // file path, URL, component name
  learned: string   // what should be remembered
}

// mem_get — retrieve relevant context
{
  query: string,
  limit?: number    // default 5
}
```

### Agent assignments

| Agent | mem_save | mem_get | Rationale |
|---|---|---|---|
| orchestrator | ✓ | ✓ | User preferences, project decisions, conversation summaries |
| code | ✓ | ✓ | Architectural decisions, repo patterns |
| web-designer | ✓ | ✓ | UI decisions, project conventions |
| secretary | ✓ | ✓ | User routines, contact patterns |
| explorer | — | ✓ | Consumer of context, not a producer |
| writer | — | ✓ | Consumer |
| math | — | ✓ | Consumer |
| debugger | — | ✓ | Consumer |
| marketing | — | ✓ | Consumer |
| graphic-designer | — | ✓ | Consumer |

### Tool permissions

- `mem_save`: `"allow"` — agents decide autonomously, no HITL
- `mem_get`: `"allow"` — read-only, no approval needed

### Environment

```
ENGRAM_URL=http://localhost:7437   (default)
```

### Docker Compose

```yaml
engram:
  image: ghcr.io/gentleman-programming/engram:latest
  ports:
    - "7437:7437"
  volumes:
    - engram-data:/root/.engram
  restart: unless-stopped
```

---

## Part 2: Thread Compaction

### Problem

WhatsApp + permanent session = infinite conversation thread. The orchestrator accumulates messages without bound, eventually exhausting the context window and degrading response quality.

### Mechanism

After each orchestrator turn, check `messages.length`. If it exceeds the threshold:

1. Take the oldest `(threshold - keep)` messages
2. Call the orchestrator's LLM to generate a structured summary
3. Save the summary to Engram via `mem_save` (type: `"conversation_summary"`)
4. Replace the compacted messages with a single short summary message in the thread
5. Continue with the remaining recent messages

```
Before: [msg1, msg2, ..., msg40]
                ↓ compaction trigger
Summarize: [msg1..msg30] → Engram (conversation_summary)
After:    ["[Resumen: ...]", msg31, ..., msg40]
```

### Configuration (env, global)

```
COMPACTION_THRESHOLD=40    # trigger compaction when messages.length > this
COMPACTION_KEEP=10         # keep this many recent messages after compaction
```

### Scope

- Only the **orchestrator** thread is compacted — specialist threads are short-lived by design (one task = one delegation).
- Compaction is triggered **post-turn** in `runtime.ts`, after the orchestrator's response is sent.
- If engram is unavailable, compaction is skipped silently (non-blocking).

### New file

- `packages/core/compaction.ts` — pure function: takes messages + LLM + memoryClient → returns compacted messages array + saves to Engram

---

## Part 3: JSONL Storage Cleanup

### chats.jsonl — O(n²) fix

**Current behavior:** appends the full `AgentChat` record (including all messages) on every state change (`active`, `waiting`, `closed`). A single chat with 3 state changes stores its messages 3 times.

**Fix:** store the full record only on `closed`. For intermediate states, store a minimal event:

```jsonl
{"chatId":"abc","state":"active","ts":1234567890}
{"chatId":"abc","state":"waiting","ts":1234567891}
{"chatId":"abc","state":"closed","messages":[...],"agentId":"...","ts":1234567892}
```

- Restore logic (`ChatManager.restore()`) reads the last record per `chatId` — behavior unchanged for `closed` chats.
- In-flight chats (interrupted mid-session) are already marked as `closed` on restore, so no data is lost.

**Modified file:** `packages/core/thread-store.ts` — `appendChatRecord()` checks `chat.state` before deciding what to persist.

### traces.jsonl — size-based rotation

**Current behavior:** unbounded append in a single file per session.

**Fix:** after each `appendTrace()`, check line count against threshold. When exceeded:

1. Rename `traces.jsonl` → `traces.<ISO-date>.jsonl`
2. Start a new empty `traces.jsonl`

```
TRACES_MAX_LINES=5000   (env-configurable, default 5000)
```

- Archived files remain on disk for manual inspection.
- No automatic deletion — storage management is left to ops.
- Line count is tracked in-memory (no disk stat per append).

**Modified file:** `packages/core/thread-store.ts` — `appendTrace()` increments an in-memory counter; rotates when counter exceeds threshold.

---

## Files Summary

### New files
| File | Purpose |
|---|---|
| `packages/core/memory-client.ts` | Engram HTTP client |
| `packages/core/memory-tools.ts` | `mem_save`, `mem_get` tool entries |
| `packages/core/compaction.ts` | Thread compaction logic |

### Modified files
| File | Change |
|---|---|
| `packages/core/runtime.ts` | Post-turn compaction hook for orchestrator |
| `packages/core/thread-store.ts` | `chats.jsonl` O(n²) fix + `traces.jsonl` rotation |
| `packages/core/agents.ts` | Assign `mem_save`/`mem_get` to agents |
| `docker-compose.yml` | Add `engram` service |
| `CLAUDE.md` | Document engram prereqs and env vars |
| `README.md` | Update architecture section |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENGRAM_URL` | `http://localhost:7437` | Engram service endpoint |
| `COMPACTION_THRESHOLD` | `40` | Messages before compaction triggers |
| `COMPACTION_KEEP` | `10` | Recent messages to keep after compaction |
| `TRACES_MAX_LINES` | `5000` | Max trace lines before rotation |

---

## Error Handling

- If engram is unreachable, `mem_save`/`mem_get` return an error message to the agent — non-fatal.
- If compaction fails (LLM error or engram unavailable), the turn completes normally without compaction — no message loss.
- If trace rotation fails (disk error), traces continue appending to the existing file — non-fatal.

---

## Out of Scope

- Automatic deletion of archived trace files (ops responsibility).
- Multi-org engram isolation (single engram instance shared across orgs for now).
- `mem_get` injection at session start (agents call it themselves when needed).
- Compaction of specialist threads.
