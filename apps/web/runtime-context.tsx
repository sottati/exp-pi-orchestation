import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentChat,
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  ScheduledJob,
  TraceEvent,
} from "../../packages/core/contracts";
import type { AgentInfo, ChatItem, DelegationBlock, HydratedUiState, UIMessage } from "./ui-state";

export type DithieState = "idle" | "thinking" | "delegating" | "error";
export type ThemeMode = "light" | "dark";

export interface HitlRequestItem {
  reqId: string;
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  timeout: number;
  reason?: string;
}

function hitlRequestHasInputFields(request?: HitlRequestItem): boolean {
  if (!request) return false;
  const maybeFields = request.params.fields;
  if (!Array.isArray(maybeFields)) return false;
  return maybeFields.some((field) => {
    if (typeof field !== "object" || field === null) return false;
    return typeof (field as { key?: unknown }).key === "string";
  });
}

export interface RuntimeState {
  orgId: string;
  agents: AgentInfo[];
  sessionId: string;
  selectedOrchestratorId: string;
  selectedContact: string;
  orchestrators: NonNullable<HydratedUiState["orchestrators"]>;
  conversations: NonNullable<HydratedUiState["conversations"]>;
  channelEvents: ChannelDeliveryEvent[];
  communicationIntents: CommunicationIntentLog[];
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
  hitlQueue: HitlRequestItem[];
}

type ServerMsg =
  | { type: "agents"; agents: AgentInfo[]; sessionId?: string; orgId?: string }
  | { type: "chat_sending"; runId: string; toAgentId?: string; orgId?: string; orchestratorId?: string; contact?: string }
  | { type: "stream_delta"; runId: string; delta: string; orgId?: string }
  | { type: "stream_end"; runId: string; answer: string; durationMs: number; orgId?: string }
  | { type: "stream_error"; runId: string; error: string; orgId?: string }
  | { type: "stream_status"; runId: string; text: string; orgId?: string }
  | { type: "trace"; event: TraceEvent; orgId?: string }
  | { type: "chat_lifecycle"; chat: AgentChat; orgId?: string }
  | { type: "job_lifecycle"; job: ScheduledJob; orgId?: string }
  | { type: "delegation_start"; runId: string; delegationId: string; fromAgentId: string; toAgentId: string; task: string; orgId?: string }
  | { type: "delegation_end"; runId: string; delegationId: string; result: string; durationMs: number; status: "ok" | "error"; orgId?: string }
  | { type: "channel_event"; event: ChannelDeliveryEvent }
  | { type: "communication_intent"; intent: CommunicationIntentLog }
  | {
    type: "hitl_request";
    reqId: string;
    agentId: string;
    toolName: string;
    params: Record<string, unknown>;
    timeout: number;
    reason?: string;
  };

type LocalAction =
  | { type: "hydrate"; snapshot: HydratedUiState }
  | { type: "set_thread_context"; orgId: string; orchestratorId: string; contact: string }
  | { type: "send_user_message"; content: string; id: string }
  | { type: "toggle_trace"; eventId: string }
  | { type: "toggle_delegation"; delegationId: string }
  | { type: "resolve_hitl_request"; reqId: string }
  | { type: "reset_dithie_state" }
  | { type: "ws_connected" }
  | { type: "ws_disconnected" };

type Action = ServerMsg | LocalAction;

const initialState: RuntimeState = {
  orgId: "",
  agents: [],
  sessionId: "",
  selectedOrchestratorId: "",
  selectedContact: "",
  orchestrators: [],
  conversations: [],
  channelEvents: [],
  communicationIntents: [],
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
  hitlQueue: [],
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

function upsertConversationFromChannelEvent(
  conversations: NonNullable<HydratedUiState["conversations"]>,
  event: ChannelDeliveryEvent,
): NonNullable<HydratedUiState["conversations"]> {
  const key = `${event.orchestratorId}:${event.contact}`;
  const preview = typeof event.metadata?.text === "string" ? String(event.metadata.text) : undefined;
  const next = conversations.filter((conversation) => `${conversation.orchestratorId}:${conversation.contact}` !== key);
  next.unshift({
    orgId: event.orgId,
    orchestratorId: event.orchestratorId,
    contact: event.contact,
    lastDirection: event.direction,
    lastStatus: event.status,
    lastTimestamp: event.timestamp,
    preview,
  });
  next.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return next;
}

function hasDelegationItem(chatItems: ChatItem[], delegationId: string): boolean {
  return chatItems.some((item) => item.kind === "delegation" && item.delegationId === delegationId);
}

function isEventForCurrentOrg(state: RuntimeState, eventOrgId?: string): boolean {
  if (!eventOrgId) return true;
  if (!state.orgId) return true;
  return state.orgId === eventOrgId;
}

function reducer(state: RuntimeState, action: Action): RuntimeState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        orgId: action.snapshot.orgId ?? state.orgId,
        agents: action.snapshot.agents,
        sessionId: action.snapshot.sessionId,
        selectedOrchestratorId: action.snapshot.selectedOrchestratorId ?? state.selectedOrchestratorId,
        selectedContact: action.snapshot.selectedContact ?? state.selectedContact,
        orchestrators: action.snapshot.orchestrators ?? [],
        conversations: action.snapshot.conversations ?? [],
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
        orgId: action.orgId ?? state.orgId,
        agents: action.agents,
        sessionId: action.sessionId ?? state.sessionId,
      };

    case "set_thread_context":
      return {
        ...state,
        orgId: action.orgId,
        selectedOrchestratorId: action.orchestratorId,
        selectedContact: action.contact,
      };

    case "chat_sending":
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
      return {
        ...state,
        orgId: action.orgId ?? state.orgId,
        selectedOrchestratorId: action.orchestratorId ?? state.selectedOrchestratorId,
        selectedContact: action.contact ?? state.selectedContact,
        dithieState: "thinking",
        isStreaming: true,
        streamBuffer: "",
        currentRunId: action.runId,
      };

    case "stream_delta":
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
      return { ...state, streamBuffer: state.streamBuffer + action.delta };

    case "stream_end": {
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
      return state;

    case "chat_lifecycle":
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
      return {
        ...state,
        chats: upsertChat(state.chats, action.chat),
      };

    case "job_lifecycle":
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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
      if (!isEventForCurrentOrg(state, action.orgId)) return state;
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

    case "channel_event":
      {
        const shouldMirrorIntoActiveThread =
          action.event.orgId === state.orgId &&
          action.event.orchestratorId === state.selectedOrchestratorId &&
          action.event.contact === state.selectedContact;

        let messages = state.messages;
        let chatItems = state.chatItems;
        if (shouldMirrorIntoActiveThread) {
          const text = typeof action.event.metadata?.text === "string"
            ? String(action.event.metadata.text)
            : "";
          if (text && action.event.direction === "inbound" && action.event.status === "received") {
            const msg: UIMessage = {
              id: `channel-in-${action.event.eventId}`,
              role: "user",
              content: text,
              timestamp: action.event.timestamp,
            };
            messages = [...messages, msg];
            chatItems = [...chatItems, { kind: "message", message: msg }];
          } else if (text && action.event.direction === "outbound" && action.event.status === "sent") {
            const msg: UIMessage = {
              id: `channel-out-${action.event.eventId}`,
              role: "assistant",
              content: text,
              timestamp: action.event.timestamp,
            };
            messages = [...messages, msg];
            chatItems = [...chatItems, { kind: "message", message: msg }];
          }
        }
        return {
        ...state,
        messages,
        chatItems,
        channelEvents: [...state.channelEvents, action.event].slice(-500),
        conversations: upsertConversationFromChannelEvent(state.conversations, action.event),
      };
      }

    case "communication_intent":
      return {
        ...state,
        communicationIntents: [action.intent, ...state.communicationIntents].slice(0, 200),
      };

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

    case "resolve_hitl_request":
      return {
        ...state,
        hitlQueue: state.hitlQueue.filter((request) => request.reqId !== action.reqId),
      };

    case "reset_dithie_state":
      return { ...state, dithieState: "idle" };

    case "ws_connected":
      return { ...state, wsConnected: true };

    case "ws_disconnected":
      return { ...state, wsConnected: false, hitlQueue: [] };

    case "hitl_request": {
      if (state.hitlQueue.some((request) => request.reqId === action.reqId)) {
        return state;
      }
      return {
        ...state,
        hitlQueue: [
          ...state.hitlQueue,
          {
            reqId: action.reqId,
            agentId: action.agentId,
            toolName: action.toolName,
            params: action.params,
            timeout: action.timeout,
            reason: action.reason,
          },
        ],
      };
    }

    default:
      return state;
  }
}

interface RuntimeContextValue {
  state: RuntimeState;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleThemeMode: () => void;
  sendMessage: (content: string) => boolean;
  selectConversation: (orgId: string, orchestratorId: string, contact?: string) => Promise<void>;
  respondToHitl: (reqId: string, approved: boolean, modifiedParams?: Record<string, unknown>) => void;
  toggleTrace: (eventId: string) => void;
  toggleDelegation: (delegationId: string) => void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);
const THEME_STORAGE_KEY = "dithie-theme-mode";
const DEFAULT_THEME_MODE: ThemeMode = "dark";

function readInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME_MODE;

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : DEFAULT_THEME_MODE;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hitlSeenRef = useRef<Set<string>>(new Set());
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readInitialThemeMode);

  useEffect(() => {
    let cancelled = false;
    const initialQuery = new URLSearchParams(window.location.search);
    const initialOrgId = initialQuery.get("orgId") ?? "";
    const initialOrchestratorId = initialQuery.get("orchestratorId") ?? "";
    const initialContact = initialQuery.get("contact") ?? "";

    const bootstrapState = async (context?: { orgId?: string; orchestratorId?: string; contact?: string }) => {
      try {
        const query = new URLSearchParams();
        if (context?.orgId) query.set("orgId", context.orgId);
        if (context?.orchestratorId) query.set("orchestratorId", context.orchestratorId);
        if (context?.contact) query.set("contact", context.contact);
        const qs = query.toString();
        const response = await fetch(`/api/ui-state${qs ? `?${qs}` : ""}`);
        if (!response.ok) return;
        const snapshot = await response.json() as HydratedUiState;
        if (cancelled) return;
        dispatch({ type: "hydrate", snapshot });
      } catch {
        // Ignore bootstrap errors; websocket can still recover live state.
      }
    };

    const scheduleReconnect = (delayMs: number) => {
      if (cancelled) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      if (cancelled) return;

      const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${wsProtocol}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: "ws_connected" });
      };
      ws.onclose = () => {
        dispatch({ type: "ws_disconnected" });
        if (!cancelled) {
          scheduleReconnect(1000);
        }
      };
      ws.onmessage = (event) => {
        try {
          dispatch(JSON.parse(event.data as string) as Action);
        } catch {
          // Ignore malformed server messages.
        }
      };
      ws.onerror = () => {
        dispatch({ type: "stream_error", runId: "", error: "WebSocket connection error" });
      };
    };

    void bootstrapState({
      orgId: initialOrgId || undefined,
      orchestratorId: initialOrchestratorId || undefined,
      contact: initialContact || undefined,
    }).then(() => connect());

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state.dithieState === "error") {
      const timer = setTimeout(() => dispatch({ type: "reset_dithie_state" }), 3000);
      return () => clearTimeout(timer);
    }
  }, [state.dithieState]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.body.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const sendMessage = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dispatch({ type: "send_user_message", content, id });
    ws.send(JSON.stringify({
      type: "chat",
      orgId: state.orgId || undefined,
      orchestratorId: state.selectedOrchestratorId || undefined,
      contact: state.selectedContact || undefined,
      content,
    }));
    return true;
  }, [state.orgId, state.selectedContact, state.selectedOrchestratorId]);

  const selectConversation = useCallback(async (orgId: string, orchestratorId: string, contact?: string) => {
    const normalizedOrg = orgId.trim();
    const normalizedOrchestrator = orchestratorId.trim();
    const normalizedContact = (contact ?? "").trim();
    if (!normalizedOrg || !normalizedOrchestrator) return;

    dispatch({
      type: "set_thread_context",
      orgId: normalizedOrg,
      orchestratorId: normalizedOrchestrator,
      contact: normalizedContact,
    });

    const query = new URLSearchParams(window.location.search);
    query.set("orgId", normalizedOrg);
    query.set("orchestratorId", normalizedOrchestrator);
    if (normalizedContact) query.set("contact", normalizedContact);
    else query.delete("contact");
    const newUrl = `${window.location.pathname}?${query.toString()}`;
    window.history.replaceState({}, "", newUrl);

    try {
      const response = await fetch(`/api/ui-state?${query.toString()}`);
      if (!response.ok) return;
      const snapshot = await response.json() as HydratedUiState;
      dispatch({ type: "hydrate", snapshot });
    } catch {
      // ignore
    }
  }, []);

  const respondToHitl = useCallback((reqId: string, approved: boolean, modifiedParams?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "hitl_response", reqId, approved, modifiedParams }));
    }
    hitlSeenRef.current.delete(reqId);
    dispatch({ type: "resolve_hitl_request", reqId });
  }, []);

  const toggleTrace = useCallback((eventId: string) => {
    dispatch({ type: "toggle_trace", eventId });
  }, []);

  const toggleDelegation = useCallback((delegationId: string) => {
    dispatch({ type: "toggle_delegation", delegationId });
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
  }, []);

  const toggleThemeMode = useCallback(() => {
    setThemeModeState((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  useEffect(() => {
    if (!state.wsConnected) {
      hitlSeenRef.current.clear();
    }
  }, [state.wsConnected]);

  useEffect(() => {
    const activeRequest = state.hitlQueue[0];
    if (!activeRequest) return;
    if (hitlSeenRef.current.has(activeRequest.reqId)) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "hitl_seen", reqId: activeRequest.reqId }));
    hitlSeenRef.current.add(activeRequest.reqId);
  }, [state.hitlQueue]);

  useEffect(() => {
    const activeRequest = state.hitlQueue[0];
    if (!activeRequest) return;
    const hasInputs = hitlRequestHasInputFields(activeRequest);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "y" && !hasInputs) {
        event.preventDefault();
        respondToHitl(activeRequest.reqId, true);
      } else if (key === "n") {
        event.preventDefault();
        respondToHitl(activeRequest.reqId, false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [respondToHitl, state.hitlQueue]);

  const value = useMemo<RuntimeContextValue>(() => ({
    state,
    themeMode,
    setThemeMode,
    toggleThemeMode,
    sendMessage,
    selectConversation,
    respondToHitl,
    toggleTrace,
    toggleDelegation,
  }), [state, themeMode, setThemeMode, toggleThemeMode, sendMessage, selectConversation, respondToHitl, toggleTrace, toggleDelegation]);

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
