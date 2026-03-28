const SACRED_TINTS = {
  green: "#39ff44",
  blue: "#0047ff",
  red: "#ff0000",
  yellow: "#ffea78",
  purple: "#8000ff",
  orange: "#ffac1c",
  pink: "#ff00ff",
} as const;

export type AgentTint = keyof typeof SACRED_TINTS;

const AGENT_TINTS: Record<string, AgentTint> = {
  orchestrator: "orange",
  code: "blue",
  math: "green",
  explorer: "yellow",
  writer: "pink",
  debugger: "red",
  secretary: "purple",
  "graphic-designer": "pink",
};

export function getAgentTint(agentId: string): AgentTint {
  return AGENT_TINTS[agentId] ?? "blue";
}

export function getAgentTintHex(agentId: string): string {
  return SACRED_TINTS[getAgentTint(agentId)];
}

export type AgentThemeMode = "light" | "dark";

export function getAgentColorTokens(agentId: string, theme: AgentThemeMode) {
  const tint = getAgentTintHex(agentId);

  if (theme === "light") {
    return {
      tint,
      border: `oklch(from ${tint} 0.45 calc(c * 0.25) h)`,
      muted: `oklch(from ${tint} 0.72 calc(c * 0.12) h)`,
      background: `oklch(from ${tint} 0.96 calc(c * 0.08) h)`,
      foreground: `oklch(from ${tint} 0.3 calc(c * 0.35) h)`,
    };
  }

  /* Oscuro: mezclar el tinte con la misma base que app.css (--theme-background-modal / --theme-border) para no desentonar */
  return {
    tint,
    border: `color-mix(in oklab, ${tint} 26%, #1f1f1f 74%)`,
    muted: `color-mix(in oklab, ${tint} 18%, rgba(255, 255, 255, 0.42) 82%)`,
    background: `color-mix(in oklab, ${tint} 11%, #0a0a0a 89%)`,
    foreground: `color-mix(in oklab, ${tint} 5%, #f2f2f2 95%)`,
  };
}

export function statusBadgeClassName(status: string) {
  const base =
    "inline-flex items-center border px-2 py-[2px] text-[10px] uppercase tracking-[0.06em]";

  if (status === "active" || status === "ok" || status === "connected") {
    return `${base} border-[var(--theme-text)] text-[var(--theme-text)]`;
  }

  if (status === "waiting" || status === "running") {
    return `${base} border-[var(--theme-button-foreground)] text-[var(--theme-button-foreground)]`;
  }

  if (status === "closed" || status === "completed") {
    return `${base} border-[var(--theme-border-subdued)] text-[var(--theme-border-subdued)]`;
  }

  if (status === "failed" || status === "error" || status === "disconnected") {
    return `${base} border-[var(--theme-border-subdued)] text-[var(--theme-button-foreground)]`;
  }

  return `${base} border-[var(--theme-border-subdued)] text-[var(--theme-text)]`;
}
