import { ChatPanel } from "../components/chat-ui";
import { TracePanel } from "../components/trace-ui";
import { useRuntime } from "../runtime-context";
import { useMemo, useState } from "react";

export function ChatPage() {
  const { state, toggleDelegation, toggleTrace, selectConversation } = useRuntime();
  const [manualContact, setManualContact] = useState("");

  const orchestratorOptions = useMemo(() => {
    if (state.orchestrators.length > 0) {
      return state.orchestrators.map((item) => item.orchestratorId);
    }
    return state.agents
      .map((agent) => agent.id)
      .filter((id) => id === "orchestrator" || id.startsWith("orchestrator:"));
  }, [state.agents, state.orchestrators]);

  const currentOrgId = state.orgId || "default";
  const currentOrchestrator = state.selectedOrchestratorId || orchestratorOptions[0] || "orchestrator";

  return (
    <div className="flex min-h-0 flex-1 max-[980px]:flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-theme-border bg-theme-surface-panel px-5 py-4 pb-3">
          <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">conversation</div>
          <div className="text-[11px] text-theme-text-muted">
            Hilo unificado UI + WhatsApp con filtro por orchestrator/contacto.
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2 text-[11px]">
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-[0.08em] text-theme-text-muted">Orchestrator</span>
              <select
                className="border border-theme-border bg-theme-surface px-2 py-1 text-theme-text"
                value={currentOrchestrator}
                onChange={(event) => {
                  void selectConversation(currentOrgId, event.target.value, state.selectedContact || undefined);
                }}
              >
                {orchestratorOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-[0.08em] text-theme-text-muted">Contacto</span>
              <input
                className="border border-theme-border bg-theme-surface px-2 py-1 text-theme-text"
                placeholder="+549..."
                value={manualContact}
                onChange={(event) => setManualContact(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="border border-theme-border px-2 py-1 text-theme-text hover:bg-theme-surface-hover"
              onClick={() => {
                void selectConversation(currentOrgId, currentOrchestrator, manualContact || undefined);
              }}
            >
              Abrir hilo
            </button>
            {state.selectedContact && (
              <span className="text-theme-text-soft">activo: {state.selectedContact}</span>
            )}
          </div>
          {state.conversations.length > 0 && (
            <div className="mt-3 flex max-h-20 flex-wrap gap-1 overflow-auto">
              {state.conversations
                .filter((conversation) => conversation.orchestratorId === currentOrchestrator)
                .slice(0, 30)
                .map((conversation) => (
                  <button
                    key={`${conversation.orchestratorId}:${conversation.contact}`}
                    type="button"
                    className="border border-theme-border px-2 py-1 text-[10px] text-theme-text-soft hover:bg-theme-surface-hover"
                    onClick={() => {
                      void selectConversation(conversation.orgId, conversation.orchestratorId, conversation.contact);
                    }}
                  >
                    {conversation.contact}
                  </button>
                ))}
            </div>
          )}
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
