import { useRuntime } from "../runtime-context";
import { TracePanel } from "../components/trace-ui";

export function TracesPage() {
  const { state, toggleTrace } = useRuntime();

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-[color:var(--theme-border)] bg-[color:var(--theme-background-modal)] px-5 py-4 pb-3">
        <div className="text-[12px] uppercase tracking-[0.14em] text-[color:var(--theme-text)]">trace explorer</div>
        <div className="text-[11px] text-[color:var(--theme-text-subtle)]">{state.traces.length} eventos en tiempo real</div>
      </div>
      <TracePanel
        traces={state.traces}
        expandedTraces={state.expandedTraces}
        traceDurations={state.traceDurations}
        onToggleTrace={toggleTrace}
        variant="page"
      />
    </section>
  );
}
