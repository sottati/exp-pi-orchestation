import React, { useMemo, useState } from "react";
import type { AgentInfo, ScheduledJobInfo, ThreadEnvelopeInfo, TraceEvent, UIMessage } from "./types";
import { AGENT_PERSONALITIES } from "./types";

interface AgentViewProps {
  agent: AgentInfo;
  traces: TraceEvent[];
  jobs: ScheduledJobInfo[];
  messages: UIMessage[];
  threadMessages: ThreadEnvelopeInfo[];
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
}

interface ChatEntry {
  id: string;
  timestamp: number;
  className: string;
  label: string;
  content: string;
  durationMs?: number;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content, null, 2);
  }
  return String(content ?? "");
}

function AgentIdentity({ agent }: { agent: AgentInfo }) {
  const personality = AGENT_PERSONALITIES[agent.id];

  return (
    <div className={`agent-identity agent-accent--${agent.id}`}>
      <div className="agent-avatar">{personality?.badge ?? agent.id[0]?.toUpperCase() ?? "?"}</div>
      <div className="agent-meta">
        <div className="agent-name">{agent.name}</div>
        <div className="agent-role">{agent.role}</div>
        {personality && <div className="agent-tagline">"{personality.tagline}"</div>}
      </div>
    </div>
  );
}

function CapabilitiesPanel({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) {
    return null;
  }

  return (
    <div className="agent-resources">
      <div className="agent-resources-title">CAPABILITIES</div>
      <div style={{ padding: "8px 16px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
        {capabilities.map((capability) => (
          <span key={capability} className="agent-resource-status">{capability}</span>
        ))}
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
      {jobs.map((job) => {
        const scheduleLabel =
          job.schedule.cron ??
          (job.schedule.type === "once" ? "once" : `${job.schedule.delayMs ?? 0}ms`);

        return (
          <div key={job.jobId} className="agent-resource-item">
            <span className={`agent-resource-status agent-resource-status--${job.status}`}>
              {job.status}
            </span>
            <span className="agent-resource-label" title={job.task}>
              {job.task.length > 50 ? `${job.task.slice(0, 50)}...` : job.task}
            </span>
            <span className="agent-resource-schedule">{scheduleLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityFeed({ traces }: { traces: TraceEvent[] }) {
  const recent = traces.slice(-50).reverse();

  return (
    <div className="agent-activity">
      <div className="agent-activity-title">ACTIVITY</div>
      {recent.length === 0 && (
        <div className="agent-activity-empty">no activity yet</div>
      )}
      {recent.map((trace) => (
        <div key={trace.eventId} className="agent-activity-item">
          <span className="agent-activity-type">{trace.type}</span>
          {trace.toolName && <span> {trace.toolName}</span>}
          <span> - {trace.status}</span>
          <span className="agent-activity-time">{formatTime(trace.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

function buildDirectChatEntries(agent: AgentInfo, messages: UIMessage[]): ChatEntry[] {
  return messages
    .filter((message) => message.agentId === agent.id)
    .map((message) => {
      const className = `message message--${message.role === "assistant" ? "dithie" : message.role}`;
      const label =
        message.role === "user"
          ? `YOU -> ${agent.id.toUpperCase()}`
          : message.role === "assistant"
            ? `${agent.id.toUpperCase()} -> YOU`
            : "ERROR";

      return {
        id: message.id,
        timestamp: message.timestamp,
        className,
        label,
        content: message.content,
        durationMs: message.durationMs,
      };
    });
}

function buildInterAgentEntries(agent: AgentInfo, threadMessages: ThreadEnvelopeInfo[]): ChatEntry[] {
  return threadMessages
    .filter((threadMessage) => {
      const isParticipant =
        threadMessage.fromAgentId === agent.id || threadMessage.toAgentId === agent.id;
      const isAgentToAgent =
        threadMessage.fromAgentId !== "user" && threadMessage.toAgentId !== "user";
      return isParticipant && isAgentToAgent;
    })
    .map((threadMessage) => {
      const text = contentToText(threadMessage.message.content).trim();
      if (!text || text.startsWith("[chat_status:")) {
        return null;
      }

      const isOutbound = threadMessage.fromAgentId === agent.id;

      return {
        id: threadMessage.envelopeId,
        timestamp: threadMessage.timestamp,
        className: `message ${isOutbound ? "message--user" : "message--dithie"}`,
        label: `${threadMessage.fromAgentId.toUpperCase()} -> ${threadMessage.toAgentId.toUpperCase()}`,
        content: text,
      } satisfies ChatEntry;
    })
    .filter((entry): entry is ChatEntry => entry !== null);
}

function ChatFeed({
  agent,
  messages,
  threadMessages,
  isStreaming,
  streamBuffer,
  streamingAgentId,
}: {
  agent: AgentInfo;
  messages: UIMessage[];
  threadMessages: ThreadEnvelopeInfo[];
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
}) {
  const entries = useMemo(() => {
    const combined = [
      ...buildInterAgentEntries(agent, threadMessages),
      ...buildDirectChatEntries(agent, messages),
    ];
    return combined.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }, [agent, messages, threadMessages]);

  const showStreaming = isStreaming && streamingAgentId === agent.id;

  return (
    <div className="agent-activity">
      <div className="agent-activity-title">CHAT</div>
      {entries.length === 0 && !showStreaming && (
        <div className="agent-activity-empty">no chat messages yet</div>
      )}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {entries.map((entry) => (
          <div key={entry.id} className={entry.className}>
            <div className="message-meta">
              {entry.label}
              <span className="message-duration">{formatTime(entry.timestamp)}</span>
              {entry.durationMs !== undefined && (
                <span className="message-duration">{(entry.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
            <pre className="message-content">{entry.content}</pre>
          </div>
        ))}

        {showStreaming && (
          <div className="message message--dithie streaming">
            <div className="message-meta">{agent.name.toUpperCase()}</div>
            <pre className="message-content">
              {streamBuffer || " "}
              <span className="streaming-cursor">|</span>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentView({
  agent,
  traces,
  jobs,
  messages,
  threadMessages,
  isStreaming,
  streamBuffer,
  streamingAgentId,
}: AgentViewProps) {
  const [tab, setTab] = useState<"activity" | "chat">("activity");

  const agentTraces = traces.filter((trace) => trace.agentId === agent.id);
  const agentJobs = jobs.filter(
    (job) => job.targetAgentId === agent.id || job.createdBy === agent.id,
  );
  const showJobs = agent.id === "secretary" || agentJobs.length > 0;

  return (
    <div className={`agent-view agent-accent--${agent.id}`}>
      <AgentIdentity agent={agent} />
      <CapabilitiesPanel capabilities={agent.capabilities} />
      {showJobs && <JobsPanel jobs={agentJobs} />}

      <div className="agent-tabs">
        <div
          className={`agent-tab${tab === "activity" ? " agent-tab--active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Activity
        </div>
        <div
          className={`agent-tab${tab === "chat" ? " agent-tab--active" : ""}`}
          onClick={() => setTab("chat")}
        >
          Chat
        </div>
      </div>

      {tab === "activity" ? (
        <ActivityFeed traces={agentTraces} />
      ) : (
        <ChatFeed
          agent={agent}
          messages={messages}
          threadMessages={threadMessages}
          isStreaming={isStreaming}
          streamBuffer={streamBuffer}
          streamingAgentId={streamingAgentId}
        />
      )}
    </div>
  );
}
