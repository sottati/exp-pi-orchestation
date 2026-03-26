import React, { useState } from "react";
import type { AgentInfo, ScheduledJobInfo, TraceEvent, UIMessage } from "./types";
import { AGENT_PERSONALITIES } from "./types";

interface AgentViewProps {
  agent: AgentInfo;
  traces: TraceEvent[];
  jobs: ScheduledJobInfo[];
  messages: UIMessage[];
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

function ChatFeed({
  agent,
  messages,
  isStreaming,
  streamBuffer,
  streamingAgentId,
}: {
  agent: AgentInfo;
  messages: UIMessage[];
  isStreaming: boolean;
  streamBuffer: string;
  streamingAgentId: string | null;
}) {
  const agentMessages = messages.filter((message) => message.agentId === agent.id);
  const showStreaming = isStreaming && streamingAgentId === agent.id;

  return (
    <div className="agent-activity">
      <div className="agent-activity-title">CHAT</div>
      {agentMessages.length === 0 && !showStreaming && (
        <div className="agent-activity-empty">no direct chat yet</div>
      )}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {agentMessages.map((message) => {
          const className = `message message--${message.role === "assistant" ? "dithie" : message.role}`;
          return (
            <div key={message.id} className={className}>
              <div className="message-meta">
                {message.role === "user" ? "YOU" : message.role === "assistant" ? agent.name.toUpperCase() : "ERROR"}
                {message.durationMs !== undefined && (
                  <span className="message-duration">{(message.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              <pre className="message-content">{message.content}</pre>
            </div>
          );
        })}

        {showStreaming && (
          <div className="message message--dithie streaming">
            <div className="message-meta">{agent.name.toUpperCase()}</div>
            <pre className="message-content">
              {streamBuffer || " "}
              <span className="streaming-cursor">¦</span>
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
          isStreaming={isStreaming}
          streamBuffer={streamBuffer}
          streamingAgentId={streamingAgentId}
        />
      )}
    </div>
  );
}
