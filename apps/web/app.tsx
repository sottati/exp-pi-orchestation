import React, { useReducer, useEffect, useRef, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { DithieSprite } from "./dithie-sprite";
import { Sidebar } from "./sidebar";
import { AgentView } from "./agent-view";
import type {
  AgentInfo,
  TraceEvent,
  DelegationBlock,
  DithieState,
  UIMessage,
  ChatItem,
  ViewTarget,
  ScheduledJobInfo,
  ThreadEnvelopeInfo,
} from "./types";
import "./app.css";

interface State {
  agents: AgentInfo[];
  activeView: ViewTarget;
  sessionId: string;
  messages: UIMessage[];
  chatItems: ChatItem[];
  jobs: ScheduledJobInfo[];
  threadMessages: ThreadEnvelopeInfo[];
  busyAgents: Set<string>;
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
  currentRunId: string | null;
  dithieState: DithieState;
  traces: TraceEvent[];
  delegations: Record<string, DelegationBlock>;
  traceStartTimes: Record<string, number>;
  traceDurations: Record<string, number>;
  expandedTraces: Set<string>;
  expandedDelegations: Set<string>;
  wsConnected: boolean;
  hitlQueue: HitlRequestItem[];
}

interface HitlRequestItem {
  reqId: string;
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  reason: string;
  timeout: number;
}

type ServerMsg =
  | { type: "agents"; agents: AgentInfo[]; sessionId?: string }
  | { type: "chat_sending"; runId: string; toAgentId: string }
  | { type: "stream_delta"; runId: string; delta: string }
  | { type: "stream_end"; runId: string; answer: string; durationMs: number }
  | { type: "stream_error"; runId: string; error: string }
  | { type: "stream_status"; runId: string; text: string }
  | { type: "trace"; event: TraceEvent }
  | { type: "chat_lifecycle"; chat: unknown }
  | { type: "job_lifecycle"; job: unknown }
  | { type: "hitl_request"; reqId: string; agentId: string; toolName: string; params: Record<string, unknown>; reason: string; timeout: number }
  | { type: "hitl_resolved"; reqId: string; approved: boolean }
  | { type: "hitl_expired"; reqId: string; agentId: string; toolName: string; timeout: number }
  | { type: "delegation_start"; runId: string; delegationId: string; fromAgentId: string; toAgentId: string; task: string }
  | { type: "delegation_end"; runId: string; delegationId: string; result: string; durationMs: number; status: "ok" | "error" };

type LocalAction =
  | { type: "send_user_message"; content: string; id: string; agentId?: string }
  | { type: "set_view"; view: ViewTarget }
  | { type: "set_thread_messages"; messages: ThreadEnvelopeInfo[] }
  | { type: "toggle_trace"; eventId: string }
  | { type: "toggle_delegation"; delegationId: string }
  | { type: "reset_dithie_state" }
  | { type: "ws_connected" }
  | { type: "ws_disconnected" };

type Action = ServerMsg | LocalAction;

// ─── Reducer ─────────────────────────────────────────────────────────────────

const initialState: State = {
  agents: [],
  activeView: "home",
  sessionId: "",
  messages: [],
  chatItems: [],
  jobs: [],
  threadMessages: [],
  busyAgents: new Set(),
  isStreaming: false,
  streamBuffer: "",
  streamingAgentId: null,
  currentRunId: null,
  dithieState: "idle",
  traces: [],
  delegations: {},
  traceStartTimes: {},
  traceDurations: {},
  expandedTraces: new Set(),
  expandedDelegations: new Set(),
  wsConnected: false,
  hitlQueue: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThreadEnvelopeInfo(value: unknown): value is ThreadEnvelopeInfo {
  if (!isRecord(value) || !isRecord(value.message)) return false;
  return (
    typeof value.envelopeId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.fromAgentId === "string" &&
    typeof value.toAgentId === "string" &&
    typeof value.message.role === "string"
  );
}

function hasRunningDelegations(delegations: Record<string, DelegationBlock>): boolean {
  return Object.values(delegations).some((delegation) => delegation.status === "running");
}

function resolveStreamingDithieState(
  streamingAgentId: string | null,
  delegations: Record<string, DelegationBlock>,
): DithieState {
  if (!streamingAgentId) {
    return "idle";
  }
  if (hasRunningDelegations(delegations)) {
    return "thinking";
  }
  return streamingAgentId === "orchestrator" ? "walking" : "thinking";
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "agents":
      return {
        ...state,
        agents: action.agents,
        sessionId: action.sessionId ?? state.sessionId,
      };

    case "chat_sending":
      {
      const newBusyAgents = new Set(state.busyAgents);
      newBusyAgents.add(action.toAgentId);
      return {
        ...state,
        dithieState: resolveStreamingDithieState(action.toAgentId, state.delegations),
        isStreaming: true,
        streamBuffer: "",
        streamingAgentId: action.toAgentId,
        currentRunId: action.runId,
        busyAgents: newBusyAgents,
      };
      }

    case "stream_delta":
      return { ...state, streamBuffer: state.streamBuffer + action.delta };

    case "stream_end": {
      const agentId = state.streamingAgentId ?? undefined;
      const msg: UIMessage = {
        id: `msg-${action.runId}`,
        role: "assistant",
        content: action.answer || state.streamBuffer,
        timestamp: Date.now(),
        runId: action.runId,
        durationMs: action.durationMs,
        agentId,
      };

      const nextBusyAgents = new Set(state.busyAgents);
      if (state.streamingAgentId) {
        nextBusyAgents.delete(state.streamingAgentId);
      }

      const nextChatItems =
        !agentId || agentId === "orchestrator"
          ? [...state.chatItems, { kind: "message" as const, message: msg }]
          : state.chatItems;

      return {
        ...state,
        isStreaming: false,
        streamBuffer: "",
        streamingAgentId: null,
        currentRunId: null,
        dithieState: "idle",
        messages: [...state.messages, msg],
        chatItems: nextChatItems,
        busyAgents: nextBusyAgents,
      };
    }

    case "stream_error": {
      const agentId = state.streamingAgentId ?? undefined;
      const msg: UIMessage = {
        id: `err-${action.runId}-${Date.now()}`,
        role: "error",
        content: `Error: ${action.error}`,
        timestamp: Date.now(),
        runId: action.runId,
        agentId,
      };

      const nextBusyAgents = new Set(state.busyAgents);
      if (state.streamingAgentId) {
        nextBusyAgents.delete(state.streamingAgentId);
      }

      const nextChatItems =
        !agentId || agentId === "orchestrator"
          ? [...state.chatItems, { kind: "message" as const, message: msg }]
          : state.chatItems;

      return {
        ...state,
        isStreaming: false,
        streamBuffer: "",
        streamingAgentId: null,
        currentRunId: null,
        dithieState: "error",
        messages: [...state.messages, msg],
        chatItems: nextChatItems,
        busyAgents: nextBusyAgents,
      };
    }

    case "stream_status":
      return state;

    case "chat_lifecycle":
      return state;

    case "job_lifecycle": {
      const maybeJob = action.job as Partial<ScheduledJobInfo> | undefined;
      if (!maybeJob || typeof maybeJob.jobId !== "string") {
        return state;
      }

      const nextJobs = state.jobs.filter((job) => job.jobId !== maybeJob.jobId);
      const nextJob = maybeJob as ScheduledJobInfo;

      if (nextJob.status !== "completed" && nextJob.status !== "failed") {
        nextJobs.push(nextJob);
      }

      return { ...state, jobs: nextJobs };
    }

    case "hitl_request": {
      if (state.hitlQueue.some((request) => request.reqId === action.reqId)) {
        return state;
      }

      const request: HitlRequestItem = {
        reqId: action.reqId,
        agentId: action.agentId,
        toolName: action.toolName,
        params: action.params,
        reason: action.reason,
        timeout: action.timeout,
      };

      return {
        ...state,
        hitlQueue: [...state.hitlQueue, request],
      };
    }

    case "hitl_resolved":
    case "hitl_expired":
      return {
        ...state,
        hitlQueue: state.hitlQueue.filter((request) => request.reqId !== action.reqId),
      };

    case "send_user_message": {
      const agentId = action.agentId;
      const msg: UIMessage = {
        id: action.id,
        role: "user",
        content: action.content,
        timestamp: Date.now(),
        agentId,
      };

      const nextChatItems =
        !agentId || agentId === "orchestrator"
          ? [...state.chatItems, { kind: "message" as const, message: msg }]
          : state.chatItems;

      return {
        ...state,
        messages: [...state.messages, msg],
        chatItems: nextChatItems,
      };
    }

    case "delegation_start": {
      const block: DelegationBlock = {
        delegationId: action.delegationId,
        fromAgentId: action.fromAgentId,
        toAgentId: action.toAgentId,
        task: action.task,
        status: "running",
      };
      const nextDelegations = { ...state.delegations, [action.delegationId]: block };
      return {
        ...state,
        dithieState: "thinking",
        delegations: nextDelegations,
        chatItems: [...state.chatItems, { kind: "delegation", delegationId: action.delegationId }],
      };
    }

    case "delegation_end": {
      const existing = state.delegations[action.delegationId];
      if (!existing) return state;
      const updated: DelegationBlock = {
        ...existing,
        result: action.result,
        status: action.status,
        durationMs: action.durationMs,
      };
      const nextDelegations = { ...state.delegations, [action.delegationId]: updated };
      return {
        ...state,
        dithieState: state.isStreaming
          ? resolveStreamingDithieState(state.streamingAgentId, nextDelegations)
          : "idle",
        delegations: nextDelegations,
      };
    }

    case "trace": {
      const evt = action.event;
      const newTraces = [...state.traces, evt].slice(-200);
      const newStartTimes = { ...state.traceStartTimes };
      const newDurations = { ...state.traceDurations };

      if (evt.type === "tool_start" || evt.type === "chat_created") {
        const key = evt.toolCallId || evt.chatId || evt.eventId;
        newStartTimes[key] = evt.timestamp;
      }

      if (evt.type === "tool_end" || evt.type === "chat_completed" || evt.type === "chat_failed") {
        const key = evt.toolCallId || evt.chatId || evt.eventId;
        const startTime = newStartTimes[key];
        if (startTime !== undefined) {
          newDurations[evt.eventId] = evt.timestamp - startTime;
        }
      }

      return {
        ...state,
        traces: newTraces,
        traceStartTimes: newStartTimes,
        traceDurations: newDurations,
      };
    }

    case "set_view":
      return { ...state, activeView: action.view };

    case "set_thread_messages": {
      const byEnvelopeId = new Map<string, ThreadEnvelopeInfo>();
      for (const message of action.messages) {
        byEnvelopeId.set(message.envelopeId, message);
      }

      const nextThreadMessages = [...byEnvelopeId.values()].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      return { ...state, threadMessages: nextThreadMessages };
    }

    case "toggle_trace": {
      const next = new Set(state.expandedTraces);
      if (next.has(action.eventId)) {
        next.delete(action.eventId);
      } else {
        next.add(action.eventId);
      }
      return { ...state, expandedTraces: next };
    }

    case "toggle_delegation": {
      const next = new Set(state.expandedDelegations);
      if (next.has(action.delegationId)) {
        next.delete(action.delegationId);
      } else {
        next.add(action.delegationId);
      }
      return { ...state, expandedDelegations: next };
    }

    case "reset_dithie_state":
      return { ...state, dithieState: "idle" };

    case "ws_connected":
      return { ...state, wsConnected: true };

    case "ws_disconnected":
      return { ...state, wsConnected: false, hitlQueue: [] };

    default:
      return state;
  }
}

// ─── Header ──────────────────────────────────────────────────────────────────

function Header({ dithieState, sessionId, wsConnected }: {
  dithieState: DithieState;
  sessionId: string;
  wsConnected: boolean;
}) {
  return (
    <div className="header">
      <div className="header-left">
        <DithieSprite size={32} state={dithieState} />
        <span className="header-label">dithie</span>
        <span className="header-state">{dithieState}</span>
      </div>
      <div className="header-right">
        {sessionId && <span className="header-session">session: {sessionId}</span>}
        <span className={`header-ws-indicator ${wsConnected ? "header-ws-indicator--connected" : "header-ws-indicator--disconnected"}`}>
          {wsConnected ? "\u25CF connected" : "\u25CB disconnected"}
        </span>
      </div>
    </div>
  );
}

// ─── InputBar ────────────────────────────────────────────────────────────────

function InputBar({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || disabled) return;
      onSend(trimmed);
      setValue("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  return (
    <div className={`input-bar${disabled ? " input-bar--disabled" : ""}`}>
      <span className="input-prompt">{">_"}</span>
      <input
        ref={inputRef}
        className="input-field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "thinking..." : (placeholder ?? "message dithie...")}
        disabled={disabled}
        autoFocus
      />
    </div>
  );
}

// ─── EmptyState ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="empty-state">
      <DithieSprite size={64} state="idle" />
      <span>send a message to start</span>
    </div>
  );
}

// ─── MessageBubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: UIMessage }) {
  const classNames = `message message--${msg.role === "assistant" ? "dithie" : msg.role}`;

  return (
    <div className={classNames}>
      <div className="message-meta">
        {msg.role === "user" ? (
          "YOU"
        ) : msg.role === "assistant" ? (
          <>
            <DithieSprite size={16} state="idle" /> DITHIE
          </>
        ) : (
          "ERROR"
        )}
        {msg.durationMs !== undefined && (
          <span className="message-duration">{(msg.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <pre className="message-content">{msg.content}</pre>
    </div>
  );
}

// ─── StreamingBubble ─────────────────────────────────────────────────────────

function StreamingBubble({ content, dithieState }: { content: string; dithieState: DithieState }) {
  const streamSpriteState = dithieState === "walking" ? "walking" : "thinking";

  return (
    <div className="message message--dithie streaming">
      <div className="message-meta">
        <DithieSprite size={16} state={streamSpriteState} /> DITHIE
      </div>
      <pre className="message-content">
        {content || "\u00a0"}
        <span className="streaming-cursor">{"\u2588"}</span>
      </pre>
    </div>
  );
}

// ─── DelegationBlockComponent ────────────────────────────────────────────────

function DelegationBlockComponent({ delegation, expanded, onToggle }: {
  delegation: DelegationBlock;
  expanded: boolean;
  onToggle: () => void;
}) {
  const taskPreview = delegation.task.length > 60
    ? delegation.task.slice(0, 60) + "\u2026"
    : delegation.task;

  const durationLabel = delegation.durationMs !== undefined
    ? ` ${(delegation.durationMs / 1000).toFixed(1)}s`
    : "";

  return (
    <div className={`delegation-block delegation-status--${delegation.status}`}>
      <div className="delegation-header" onClick={onToggle}>
        <span className={`delegation-arrow${expanded ? " expanded" : ""}`}>{"\u25B8"}</span>
        <span className="delegation-label">
          dithie &rarr; {delegation.toAgentId}: &quot;{taskPreview}&quot;{durationLabel}
        </span>
      </div>
      {expanded && (
        <div className="delegation-body">
          <div><strong>Task:</strong> {delegation.task}</div>
          {delegation.result && <div><strong>Result:</strong> {delegation.result}</div>}
          <div><strong>Status:</strong> {delegation.status}</div>
        </div>
      )}
    </div>
  );
}

// ─── ChatPanel ───────────────────────────────────────────────────────────────

function ChatPanel({ state, dispatch }: { state: State; dispatch: React.Dispatch<Action> }) {
  const listRef = useRef<HTMLDivElement>(null);

  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    wasNearBottomRef.current = isNearBottom();
  });

  useEffect(() => {
    if (wasNearBottomRef.current) {
      scrollToBottom();
    }
  }, [state.chatItems.length, state.streamBuffer, scrollToBottom]);

  const isEmpty = state.chatItems.length === 0 && !state.isStreaming;

  if (isEmpty) {
    return (
      <div className="chat-panel">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="message-list" ref={listRef}>
        {state.chatItems.map((item, idx) => {
          if (item.kind === "message") {
            return <MessageBubble key={item.message.id} msg={item.message} />;
          }
          const delegation = state.delegations[item.delegationId];
          if (!delegation) return null;
          return (
            <DelegationBlockComponent
              key={item.delegationId}
              delegation={delegation}
              expanded={state.expandedDelegations.has(item.delegationId)}
              onToggle={() => dispatch({ type: "toggle_delegation", delegationId: item.delegationId })}
            />
          );
        })}
        {state.isStreaming && <StreamingBubble content={state.streamBuffer} dithieState={state.dithieState} />}
      </div>
    </div>
  );
}

// ─── TraceItem ───────────────────────────────────────────────────────────────

function TraceItem({ trace, expanded, duration, onToggle }: {
  trace: TraceEvent;
  expanded: boolean;
  duration?: number;
  onToggle: () => void;
}) {
  let statusPrefix = "";
  let statusStyle: React.CSSProperties = {};
  if (trace.status === "ok" || trace.status === "completed") {
    statusPrefix = "\u2713 ";
  } else if (trace.status === "error") {
    statusPrefix = "\u2717 ";
  } else if (trace.status === "cancelled") {
    statusStyle = { textDecoration: "line-through" };
  }

  const durationLabel = duration !== undefined ? `${(duration / 1000).toFixed(1)}s` : "";

  return (
    <>
      <div
        className={`trace-item${expanded ? " expanded" : ""}`}
        onClick={onToggle}
        style={statusStyle}
      >
        <span className="trace-type">{statusPrefix}{trace.type}</span>
        {trace.agentId && <span className="trace-agent">{trace.agentId}</span>}
        <span className="trace-status">{trace.status}</span>
        {durationLabel && <span className="trace-duration">{durationLabel}</span>}
      </div>
      {expanded && trace.details && (
        <div className="trace-details">
          {Object.entries(trace.details).map(([key, val]) => (
            <div key={key}>{key}: {typeof val === "object" ? JSON.stringify(val) : String(val)}</div>
          ))}
          {trace.toolName && <div>tool: {trace.toolName}</div>}
        </div>
      )}
    </>
  );
}

// ─── TracePanel ──────────────────────────────────────────────────────────────

function TracePanel({ traces, expandedTraces, traceDurations, onToggleTrace }: {
  traces: TraceEvent[];
  expandedTraces: Set<string>;
  traceDurations: Record<string, number>;
  onToggleTrace: (eventId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  useEffect(() => {
    wasNearBottomRef.current = isNearBottom();
  });

  useEffect(() => {
    const el = listRef.current;
    if (el && wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [traces.length]);

  return (
    <div className="trace-panel">
      <div className="trace-panel-title">TRACES</div>
      <div className="trace-list" ref={listRef}>
        {traces.length === 0 && <div className="trace-empty">no traces yet</div>}
        {traces.map((t) => (
          <TraceItem
            key={t.eventId}
            trace={t}
            expanded={expandedTraces.has(t.eventId)}
            duration={traceDurations[t.eventId]}
            onToggle={() => onToggleTrace(t.eventId)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

function HitlPrompt({
  request,
  queueSize,
  onAllow,
  onDeny,
}: {
  request: HitlRequestItem;
  queueSize: number;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const timeoutSeconds = Math.max(1, Math.floor(request.timeout / 1000));
  let paramsPreview = "{}";
  try {
    paramsPreview = JSON.stringify(request.params, null, 2);
  } catch {
    paramsPreview = String(request.params);
  }

  return (
    <div className="hitl-overlay" role="dialog" aria-modal="true" aria-live="assertive">
      <div className="hitl-card">
        <div className="hitl-title">Approval required</div>
        <div className="hitl-subtitle">
          {request.agentId} wants to run <code>{request.toolName}</code>.
        </div>
        <div className="hitl-reason">{request.reason}</div>
        <div className="hitl-meta">
          <span>timeout: {timeoutSeconds}s</span>
          {queueSize > 1 && <span>pending: {queueSize}</span>}
        </div>
        <div className="hitl-section-title">params</div>
        <pre className="hitl-params">{paramsPreview}</pre>
        <div className="hitl-actions">
          <button type="button" className="hitl-btn hitl-btn--allow" onClick={onAllow}>
            Allow (y)
          </button>
          <button type="button" className="hitl-btn hitl-btn--deny" onClick={onDeny}>
            Don&apos;t Allow (n)
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const activeHitlRequest = state.hitlQueue[0];

  const refreshThreadMessages = useCallback(() => {
    fetch("/api/threads")
      .then((response) => response.json())
      .then(async (threadIds: unknown) => {
        if (!Array.isArray(threadIds)) {
          return;
        }

        const threadResponses = await Promise.all(
          threadIds
            .filter((threadId): threadId is string => typeof threadId === "string")
            .map(async (threadId) => {
              const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
              if (!response.ok) {
                return [] as unknown[];
              }
              const payload = await response.json();
              return Array.isArray(payload) ? payload : [];
            }),
        );

        const allThreadMessages = threadResponses
          .flat()
          .filter(isThreadEnvelopeInfo);

        dispatch({ type: "set_thread_messages", messages: allThreadMessages });
      })
      .catch(() => {
        // ignore thread refresh failures
      });
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      dispatch({ type: "ws_connected" });
      fetch("/api/jobs")
        .then((response) => response.json())
        .then((jobs: unknown) => {
          if (!Array.isArray(jobs)) {
            return;
          }
          for (const job of jobs) {
            dispatch({ type: "job_lifecycle", job });
          }
        })
        .catch(() => {
          // ignore initial jobs fetch failures
        });
      refreshThreadMessages();
    };
    ws.onclose = () => dispatch({ type: "ws_disconnected" });
    ws.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data as string) as ServerMsg;

        if (payload.type === "hitl_request" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "hitl_seen", reqId: payload.reqId }));
        }

        dispatch(payload);
        if (
          payload.type === "chat_lifecycle" ||
          payload.type === "delegation_end" ||
          payload.type === "stream_end"
        ) {
          refreshThreadMessages();
        }
      } catch { /* ignore parse errors */ }
    };
    ws.onerror = () => dispatch({ type: "stream_error", runId: "", error: "WebSocket connection error" });
    return () => ws.close();
  }, [refreshThreadMessages]);

  useEffect(() => {
    if (state.dithieState === "error") {
      const timer = setTimeout(() => dispatch({ type: "reset_dithie_state" }), 3000);
      return () => clearTimeout(timer);
    }
  }, [state.dithieState]);

  const handleSend = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toAgentId = state.activeView === "home" ? "orchestrator" : state.activeView;
    dispatch({ type: "send_user_message", content, id, agentId: toAgentId });
    ws.send(JSON.stringify({ type: "chat", toAgentId, content }));
  }, [state.activeView]);

  const sendHitlResponse = useCallback((reqId: string, approved: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: "hitl_response", reqId, approved }));
  }, []);

  useEffect(() => {
    if (!activeHitlRequest) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "y") {
        event.preventDefault();
        sendHitlResponse(activeHitlRequest.reqId, true);
      } else if (key === "n") {
        event.preventDefault();
        sendHitlResponse(activeHitlRequest.reqId, false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeHitlRequest, sendHitlResponse]);

  return (
    <div className="app">
      <Header dithieState={state.dithieState} sessionId={state.sessionId} wsConnected={state.wsConnected} />
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
            const agent = state.agents.find((candidate) => candidate.id === state.activeView);
            if (!agent) {
              return <ChatPanel state={state} dispatch={dispatch} />;
            }

            return (
              <AgentView
                agent={agent}
                traces={state.traces}
                jobs={state.jobs}
                messages={state.messages}
                threadMessages={state.threadMessages}
                isStreaming={state.isStreaming}
                streamBuffer={state.streamBuffer}
                streamingAgentId={state.streamingAgentId}
              />
            );
          })()
        )}
        <TracePanel
          traces={
            state.activeView === "home"
              ? state.traces
              : state.traces.filter((trace) => trace.agentId === state.activeView)
          }
          expandedTraces={state.expandedTraces}
          traceDurations={state.traceDurations}
          onToggleTrace={(id) => dispatch({ type: "toggle_trace", eventId: id })}
        />
      </div>
      <InputBar
        onSend={handleSend}
        disabled={state.isStreaming}
        placeholder={
          state.activeView === "home"
            ? "message dithie..."
            : `message ${state.agents.find((agent) => agent.id === state.activeView)?.name ?? state.activeView}...`
        }
      />
      {activeHitlRequest && (
        <HitlPrompt
          request={activeHitlRequest}
          queueSize={state.hitlQueue.length}
          onAllow={() => sendHitlResponse(activeHitlRequest.reqId, true)}
          onDeny={() => sendHitlResponse(activeHitlRequest.reqId, false)}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
