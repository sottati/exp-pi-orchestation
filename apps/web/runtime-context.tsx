import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type { AgentChat, ScheduledJob, TraceEvent } from "../../packages/core/contracts";
import type { AgentInfo, ChatItem, DelegationBlock, HydratedUiState, UIMessage } from "./ui-state";

export type DithieState = "idle" | "thinking" | "delegating" | "error";

export interface RuntimeState {
  agents: AgentInfo[];
  sessionId: string;
  messages: UIMessage[];
  chatItems: ChatItem[];
  isStreaming: boolean;
  streamBuffer: string;
  currentRunId: string | null;
  dithieState: DithieState;
  traces: TraceEvent[];
  delegations: Record<string, DelegationBlock>;
  traceStartTimes: Record<string, number>;
  traceDurations: Record<string, number>;
  expandedTraces: Set<string>;
  expandedDelegations: Set<string>;
  wsConnected: boolean;
  chats: AgentChat[];
  jobs: ScheduledJob[];
}

type ServerMsg =
  | { type: "agents"; agents: AgentInfo[]; sessionId?: string }
  | { type: "chat_sending"; runId: string; toAgentId: string }
  | { type: "stream_delta"; runId: string; delta: string }
  | { type: "stream_end"; runId: string; answer: string; durationMs: number }
  | { type: "stream_error"; runId: string; error: string }
  | { type: "stream_status"; runId: string; text: string }
  | { type: "trace"; event: TraceEvent }
  | { type: "chat_lifecycle"; chat: AgentChat }
  | { type: "job_lifecycle"; job: ScheduledJob }
  | { type: "delegation_start"; runId: string; delegationId: string; fromAgentId: string; toAgentId: string; task: string }
  | { type: "delegation_end"; runId: string; delegationId: string; result: string; durationMs: number; status: "ok" | "error" }
  | { type: "hitl_request"; reqId: string; agentId: string; toolName: string; params: Record<string, unknown>; timeout: number };

type LocalAction =
  | { type: "hydrate"; snapshot: HydratedUiState }
  | { type: "send_user_message"; content: string; id: string }
  | { type: "toggle_trace"; eventId: string }
  | { type: "toggle_delegation"; delegationId: string }
  | { type: "reset_dithie_state" }
  | { type: "ws_connected" }
  | { type: "ws_disconnected" };

type Action = ServerMsg | LocalAction;

const initialState: RuntimeState = {
  agents: [],
  sessionId: "",
  messages: [],
  chatItems: [],
  isStreaming: false,
  streamBuffer: "",
  currentRunId: null,
  dithieState: "idle",
  traces: [],
  delegations: {},
  traceStartTimes: {},
  traceDurations: {},
  expandedTraces: new Set(),
  expandedDelegations: new Set(),
  wsConnected: false,
  chats: [],
  jobs: [],
};

function deriveTraceStartTimes(traces: TraceEvent[]): Record<string, number> {
  const startTimes: Record<string, number> = {};
  for (const trace of traces) {
    if (trace.type === "tool_start" || trace.type === "chat_created") {
      const key = trace.toolCallId || trace.chatId || trace.eventId;
      startTimes[key] = trace.timestamp;
    }
  }
  return startTimes;
}

function upsertChat(chats: AgentChat[], chat: AgentChat): AgentChat[] {
  const next = chats.filter((item) => item.chatId !== chat.chatId);
  next.unshift(chat);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

function upsertJob(jobs: ScheduledJob[], job: ScheduledJob): ScheduledJob[] {
  const next = jobs.filter((item) => item.jobId !== job.jobId);
  next.unshift(job);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

function hasDelegationItem(chatItems: ChatItem[], delegationId: string): boolean {
  return chatItems.some((item) => item.kind === "delegation" && item.delegationId === delegationId);
}

function reducer(state: RuntimeState, action: Action): RuntimeState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        agents: action.snapshot.agents,
        sessionId: action.snapshot.sessionId,
        messages: action.snapshot.messages,
        chatItems: action.snapshot.chatItems,
        traces: action.snapshot.traces,
        delegations: action.snapshot.delegations,
        traceStartTimes: deriveTraceStartTimes(action.snapshot.traces),
        traceDurations: action.snapshot.traceDurations,
        chats: action.snapshot.chats,
        jobs: action.snapshot.jobs,
      };

    case "agents":
      return {
        ...state,
        agents: action.agents,
        sessionId: action.sessionId ?? state.sessionId,
      };

    case "chat_sending":
      return {
        ...state,
        dithieState: "thinking",
        isStreaming: true,
        streamBuffer: "",
        currentRunId: action.runId,
      };

    case "stream_delta":
      return { ...state, streamBuffer: state.streamBuffer + action.delta };

    case "stream_end": {
      const msg: UIMessage = {
        id: `msg-${action.runId}`,
        role: "assistant",
        content: action.answer || state.streamBuffer,
        timestamp: Date.now(),
        runId: action.runId,
        durationMs: action.durationMs,
      };
      return {
        ...state,
        isStreaming: false,
        streamBuffer: "",
        currentRunId: null,
        dithieState: "idle",
        messages: [...state.messages, msg],
        chatItems: [...state.chatItems, { kind: "message", message: msg }],
      };
    }

    case "stream_error": {
      const msg: UIMessage = {
        id: `err-${action.runId || "socket"}-${Date.now()}`,
        role: "error",
        content: `Error: ${action.error}`,
        timestamp: Date.now(),
        runId: action.runId || undefined,
      };
      return {
        ...state,
        isStreaming: false,
        streamBuffer: "",
        currentRunId: null,
        dithieState: "error",
        messages: [...state.messages, msg],
        chatItems: [...state.chatItems, { kind: "message", message: msg }],
      };
    }

    case "stream_status":
      return state;

    case "chat_lifecycle":
      return {
        ...state,
        chats: upsertChat(state.chats, action.chat),
      };

    case "job_lifecycle":
      return {
        ...state,
        jobs: upsertJob(state.jobs, action.job),
      };

    case "send_user_message": {
      const msg: UIMessage = {
        id: action.id,
        role: "user",
        content: action.content,
        timestamp: Date.now(),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        chatItems: [...state.chatItems, { kind: "message", message: msg }],
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
      return {
        ...state,
        dithieState: "delegating",
        delegations: { ...state.delegations, [action.delegationId]: block },
        chatItems: hasDelegationItem(state.chatItems, action.delegationId)
          ? state.chatItems
          : [...state.chatItems, { kind: "delegation", delegationId: action.delegationId }],
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
      return {
        ...state,
        dithieState: state.isStreaming ? "thinking" : "idle",
        delegations: { ...state.delegations, [action.delegationId]: updated },
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
      return { ...state, wsConnected: false };

    case "hitl_request":
      return state;

    default:
      return state;
  }
}

interface RuntimeContextValue {
  state: RuntimeState;
  sendMessage: (content: string) => boolean;
  toggleTrace: (eventId: string) => void;
  toggleDelegation: (delegationId: string) => void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
      try {
        const response = await fetch("/api/ui-state");
        if (response.ok) {
          const snapshot = await response.json() as HydratedUiState;
          if (!cancelled) {
            dispatch({ type: "hydrate", snapshot });
          }
        }
      } catch {
        // Ignore bootstrap errors; websocket can still recover live state.
      }

      if (cancelled) return;

      const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${wsProtocol}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => dispatch({ type: "ws_connected" });
      ws.onclose = () => dispatch({ type: "ws_disconnected" });
      ws.onmessage = (event) => {
        try {
          dispatch(JSON.parse(event.data as string) as Action);
        } catch {
          // Ignore malformed server messages.
        }
      };
      ws.onerror = () => dispatch({ type: "stream_error", runId: "", error: "WebSocket connection error" });
    };

    void connect();

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (state.dithieState === "error") {
      const timer = setTimeout(() => dispatch({ type: "reset_dithie_state" }), 3000);
      return () => clearTimeout(timer);
    }
  }, [state.dithieState]);

  const sendMessage = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dispatch({ type: "send_user_message", content, id });
    ws.send(JSON.stringify({ type: "chat", toAgentId: "orchestrator", content }));
    return true;
  }, []);

  const toggleTrace = useCallback((eventId: string) => {
    dispatch({ type: "toggle_trace", eventId });
  }, []);

  const toggleDelegation = useCallback((delegationId: string) => {
    dispatch({ type: "toggle_delegation", delegationId });
  }, []);

  const value = useMemo<RuntimeContextValue>(() => ({
    state,
    sendMessage,
    toggleTrace,
    toggleDelegation,
  }), [state, sendMessage, toggleTrace, toggleDelegation]);

  return (
    <RuntimeContext.Provider value={value}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime() {
  const context = useContext(RuntimeContext);
  if (!context) {
    throw new Error("useRuntime must be used inside RuntimeProvider");
  }
  return context;
}
