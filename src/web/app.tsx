import React, { useReducer, useEffect, useRef, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

interface AgentInfo {
    id: string;
    name: string;
    role: string;
    capabilities: string[];
    maxConcurrency: number;
}

interface TraceEvent {
    eventId: string;
    timestamp: number;
    type: string;
    status: string;
    agentId?: string;
    chatId?: string;
    details?: Record<string, unknown>;
}

interface UIMessage {
    id: string;
    role: "user" | "assistant" | "error";
    agentId: string;
    content: string;
    timestamp: number;
    runId?: string;
    durationMs?: number;
}

interface State {
    agents: AgentInfo[];
    activeAgent: string;
    messages: UIMessage[];
    isStreaming: boolean;
    streamBuffer: string;
    currentRunId: string | null;
    traces: TraceEvent[];
}

type ServerMsg =
    | { type: "agents"; agents: AgentInfo[] }
    | { type: "chat_sending"; runId: string; toAgentId: string }
    | { type: "stream_delta"; runId: string; delta: string }
    | { type: "stream_end"; runId: string; answer: string; durationMs: number }
    | { type: "stream_error"; runId: string; error: string }
    | { type: "trace"; event: TraceEvent }
    | { type: "chat_lifecycle"; chat: unknown };

type LocalAction =
    | { type: "switch_agent"; agentId: string }
    | { type: "send_user_message"; agentId: string; content: string; id: string };

type Action = ServerMsg | LocalAction;

const AGENT_COLORS: Record<string, string> = {
    orchestrator: "var(--orchestrator)",
    code: "var(--code)",
    math: "var(--math)",
};

function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "agents":
            return {
                ...state,
                agents: action.agents,
                activeAgent: state.activeAgent || action.agents[0]?.id || "orchestrator",
            };

        case "switch_agent":
            return { ...state, activeAgent: action.agentId };

        case "send_user_message":
            return {
                ...state,
                messages: [
                    ...state.messages,
                    {
                        id: action.id,
                        role: "user",
                        agentId: action.agentId,
                        content: action.content,
                        timestamp: Date.now(),
                    },
                ],
            };

        case "chat_sending":
            return { ...state, isStreaming: true, streamBuffer: "", currentRunId: action.runId };

        case "stream_delta":
            return { ...state, streamBuffer: state.streamBuffer + action.delta };

        case "stream_end": {
            const msg: UIMessage = {
                id: `msg-${action.runId}`,
                role: "assistant",
                agentId: state.activeAgent,
                content: action.answer,
                timestamp: Date.now(),
                runId: action.runId,
                durationMs: action.durationMs,
            };
            return {
                ...state,
                isStreaming: false,
                streamBuffer: "",
                currentRunId: null,
                messages: [...state.messages, msg],
            };
        }

        case "stream_error": {
            const msg: UIMessage = {
                id: `err-${action.runId}`,
                role: "error",
                agentId: state.activeAgent,
                content: `Error: ${action.error}`,
                timestamp: Date.now(),
                runId: action.runId,
            };
            return {
                ...state,
                isStreaming: false,
                streamBuffer: "",
                currentRunId: null,
                messages: [...state.messages, msg],
            };
        }

        case "trace":
            return { ...state, traces: [action.event, ...state.traces].slice(0, 50) };

        case "chat_lifecycle":
            return state; // could show chat state in trace panel in the future

        default:
            return state;
    }
}

const initialState: State = {
    agents: [],
    activeAgent: "orchestrator",
    messages: [],
    isStreaming: false,
    streamBuffer: "",
    currentRunId: null,
    traces: [],
};

// ─── AgentBar ────────────────────────────────────────────────────────────────

function AgentBar({ agents, activeAgent, onSelect }: {
    agents: AgentInfo[];
    activeAgent: string;
    onSelect: (id: string) => void;
}) {
    return (
        <div className="agent-bar">
            <span className="agent-bar-title">pi-agent</span>
            <div className="agent-bar-buttons">
                {agents.map((agent) => (
                    <button
                        key={agent.id}
                        className={`agent-btn agent-btn--${agent.id}${activeAgent === agent.id ? " active" : ""}`}
                        onClick={() => onSelect(agent.id)}
                    >
                        {agent.name}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── MessageList ──────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: UIMessage }) {
    const color = msg.role === "user"
        ? "var(--user)"
        : AGENT_COLORS[msg.agentId] ?? "var(--text-muted)";

    return (
        <div
            className={`message message--${msg.role}`}
            style={{ "--agent-color": color } as React.CSSProperties}
        >
            <div className="message-meta">
                {msg.role === "user" ? "you" : msg.agentId}
                {msg.durationMs !== undefined && (
                    <span className="message-duration"> {(msg.durationMs / 1000).toFixed(1)}s</span>
                )}
            </div>
            <pre className="message-content">{msg.content}</pre>
        </div>
    );
}

function StreamingBubble({ agentId, content }: { agentId: string; content: string }) {
    const color = AGENT_COLORS[agentId] ?? "var(--text-muted)";
    return (
        <div
            className="message message--assistant streaming"
            style={{ "--agent-color": color } as React.CSSProperties}
        >
            <div className="message-meta">
                {agentId} <span className="streaming-dot">●</span>
            </div>
            <pre className="message-content">{content || "\u00a0"}</pre>
        </div>
    );
}

function MessageList({ messages, activeAgent, isStreaming, streamBuffer }: {
    messages: UIMessage[];
    activeAgent: string;
    isStreaming: boolean;
    streamBuffer: string;
}) {
    const endRef = useRef<HTMLDivElement>(null);
    const filtered = messages.filter((m) => m.agentId === activeAgent);

    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [filtered.length, streamBuffer]);

    return (
        <div className="message-list">
            {filtered.length === 0 && !isStreaming && (
                <div className="message-list-empty">Send a message to {activeAgent}…</div>
            )}
            {filtered.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
            {isStreaming && <StreamingBubble agentId={activeAgent} content={streamBuffer} />}
            <div ref={endRef} />
        </div>
    );
}

// ─── TracePanel ───────────────────────────────────────────────────────────────

const TRACE_STATUS_COLORS: Record<string, string> = {
    ok: "var(--code)",
    completed: "var(--code)",
    error: "var(--error)",
    running: "var(--orchestrator)",
    queued: "var(--math)",
    cancelled: "var(--text-muted)",
};

function TracePanel({ traces }: { traces: TraceEvent[] }) {
    return (
        <div className="trace-panel">
            <div className="trace-panel-title">traces</div>
            <div className="trace-list">
                {traces.length === 0 && <div className="trace-empty">no traces yet</div>}
                {traces.map((t) => (
                    <div
                        key={t.eventId}
                        className="trace-item"
                        style={{ borderLeftColor: TRACE_STATUS_COLORS[t.status] ?? "var(--border)" } as React.CSSProperties}
                    >
                        <span className="trace-type">{t.type}</span>
                        {t.agentId && <span className="trace-agent">{t.agentId}</span>}
                        <span className="trace-status">{t.status}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── InputBar ────────────────────────────────────────────────────────────────

function InputBar({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
    const [value, setValue] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setValue("");
    };

    return (
        <form className="input-bar" onSubmit={handleSubmit}>
            <input
                className="input-bar-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={disabled ? "Waiting for response…" : "Message…"}
                disabled={disabled}
                autoFocus
            />
            <button className="input-bar-btn" type="submit" disabled={disabled || !value.trim()}>
                Send
            </button>
        </form>
    );
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
    const [state, dispatch] = useReducer(reducer, initialState);
    const wsRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        wsRef.current = ws;

        ws.onmessage = (e) => {
            try {
                dispatch(JSON.parse(e.data as string));
            } catch { /* ignore parse errors */ }
        };

        ws.onerror = () => {
            dispatch({ type: "stream_error", runId: "", error: "WebSocket connection error" });
        };

        return () => ws.close();
    }, []);

    const handleSend = useCallback((content: string) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const id = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        dispatch({ type: "send_user_message", agentId: state.activeAgent, content, id });
        ws.send(JSON.stringify({ type: "chat", toAgentId: state.activeAgent, content }));
    }, [state.activeAgent]);

    const handleSwitchAgent = useCallback((agentId: string) => {
        dispatch({ type: "switch_agent", agentId });
    }, []);

    return (
        <div className="app">
            <AgentBar
                agents={state.agents}
                activeAgent={state.activeAgent}
                onSelect={handleSwitchAgent}
            />
            <div className="main">
                <MessageList
                    messages={state.messages}
                    activeAgent={state.activeAgent}
                    isStreaming={state.isStreaming}
                    streamBuffer={state.streamBuffer}
                />
                <TracePanel traces={state.traces} />
            </div>
            <InputBar onSend={handleSend} disabled={state.isStreaming} />
        </div>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
