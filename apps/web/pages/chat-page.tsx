import { ChatPanel } from "../components/chat-ui";
import { TracePanel } from "../components/trace-ui";
import { useRuntime } from "../runtime-context";

export function ChatPage() {
  const { state, toggleDelegation, toggleTrace } = useRuntime();

  return (
    <div className="split-page">
      <section className="split-page-main">
        <div className="page-header">
          <div className="page-title">conversation</div>
          <div className="page-subtitle">Chat principal con Dithie y bloques inline de delegacion.</div>
        </div>
        <ChatPanel state={state} onToggleDelegation={toggleDelegation} />
      </section>
      <section className="trace-panel">
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
