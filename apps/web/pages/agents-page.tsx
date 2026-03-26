import type { CSSProperties } from "react";
import { getAgentColorTokens } from "../lib/agent-colors";
import { useRuntime } from "../runtime-context";

export function AgentsPage() {
  const { state, themeMode } = useRuntime();

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-theme-border bg-theme-surface px-5 pt-4 pb-3">
        <div>
          <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">Agents</div>
          <div className="text-[11px] text-theme-text-soft">Catalogo del runtime compartido por la UI.</div>
        </div>
        <span className="inline-flex items-center self-start border border-theme-border px-2 py-[2px] text-[10px] uppercase tracking-[0.06em] text-theme-text">
          {state.agents.length} total
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-2.5 px-5 pt-4 pb-5">
        {state.agents.map((agent) => {
          const colors = getAgentColorTokens(agent.id, themeMode);

          return (
            <article
              key={agent.id}
              className="flex flex-col gap-2.5 border border-theme-border bg-theme-input px-3.5 py-3"
              style={
                {
                  "--agent-border": colors.border,
                  "--agent-muted": colors.muted,
                  "--agent-bg": colors.background,
                  "--agent-fg": colors.foreground,
                } as CSSProperties
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--agent-fg)]">{agent.name}</div>
                  <div className="break-all text-[11px] text-[var(--agent-muted)]">{agent.id}</div>
                </div>
                <span
                  className="inline-flex items-center border px-2 py-[2px] text-[10px] uppercase tracking-[0.06em]"
                  style={{
                    borderColor: "var(--agent-border)",
                    background: "var(--agent-bg)",
                    color: "var(--agent-fg)",
                  }}
                >
                  {agent.maxConcurrency} slots
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-3 gap-y-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Role</span>
                  <span className="break-words text-[12px] text-theme-text">{agent.role}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Capabilities</span>
                  <span className="text-[12px] text-theme-text">{agent.capabilities.length}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {agent.capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="inline-flex items-center border px-2 py-[2px] text-[10px] uppercase tracking-[0.06em]"
                    style={{
                      borderColor: "var(--agent-border)",
                      background: "var(--agent-bg)",
                      color: "var(--agent-fg)",
                    }}
                  >
                    {capability}
                  </span>
                ))}
              </div>
            </article>
          );
        })}
        {state.agents.length === 0 && (
          <div className="px-5 py-[18px] text-[12px] text-theme-border-subdued">no agents available</div>
        )}
        </div>
      </div>
    </section>
  );
}
