import { ChatPanel } from "../components/chat-ui";
import { TracePanel } from "../components/trace-ui";
import { useRuntime } from "../runtime-context";

export function ChatPage() {
  const { state, toggleDelegation, toggleTrace } = useRuntime();

  return (
    <div className="flex min-h-0 flex-1 max-[980px]:flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-theme-border bg-theme-surface-panel px-5 py-4 pb-3">
          <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">conversation</div>
          <div className="text-[11px] text-theme-text-muted">
            Chat principal con Dithie y bloques inline de delegacion.
          </div>
        </div>
        <ChatPanel state={state} onToggleDelegation={toggleDelegation} />
      </section>
      <section className="flex w-[var(--trace-w)] shrink-0 flex-col overflow-hidden border-l border-theme-border max-[980px]:min-h-[220px] max-[980px]:w-full max-[980px]:border-l-0 max-[980px]:border-t">
        <TracePanel
          traces={state.traces}
          expandedTraces={state.expandedTraces}
          traceDurations={state.traceDurations}
          onToggleTrace={toggleTrace}
        />
      </section>
    </div>
  );
}
