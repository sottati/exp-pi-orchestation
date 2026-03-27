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

export type DithieState = "idle" | "thinking" | "walking" | "delegating" | "error";

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
  runId?: string;
  durationMs?: number;
  agentId?: string;
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

export interface ThreadEnvelopeInfo {
  envelopeId: string;
  threadId: string;
  timestamp: number;
  fromAgentId: string;
  toAgentId: string;
  chatId?: string;
  message: {
    role: string;
    content: unknown;
    timestamp?: number;
  };
}

export type ChatItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "delegation"; delegationId: string };

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
  "web-designer": { accent: "#ff5555", badge: "F", tagline: "pixels with purpose" },
  marketing:      { accent: "#69ff94", badge: "K", tagline: "growth is the game" },
};
