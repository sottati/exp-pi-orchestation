import { useRuntime } from "../runtime-context";
import { TracePanel } from "../components/trace-ui";

export function TracesPage() {
  const { state, toggleTrace } = useRuntime();

  return (
    <section className="page stack-page">
      <div className="page-header">
        <div className="page-title">trace explorer</div>
        <div className="page-subtitle">{state.traces.length} eventos en tiempo real</div>
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
