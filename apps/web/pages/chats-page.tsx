import type { AgentChat } from "../../../packages/core/contracts";
import { useRuntime } from "../runtime-context";

function formatTimestamp(value?: number): string {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function chatSubtitle(chat: AgentChat): string {
  if (chat.status === "closed") {
    return chat.closeReason ? `${chat.status} · ${chat.closeReason}` : chat.status;
  }
  return chat.status;
}

export function ChatsPage() {
  const { state } = useRuntime();

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <div className="page-title">delegations</div>
          <div className="page-subtitle">Estado de chats internos entre el orquestador y especialistas.</div>
        </div>
        <div className="resource-pill" data-status={state.chats.length > 0 ? "active" : "closed"}>
          {state.chats.length} total
        </div>
      </div>

      <div className="page-body">
        <div className="table-view">
        {state.chats.length === 0 && (
          <div className="empty-block">No hay chats delegados registrados todavia.</div>
        )}

        {state.chats.map((chat) => (
          <article key={chat.chatId} className="resource-card">
            <div className="resource-card-header">
              <div>
                <div className="resource-card-title">{chat.agentId}</div>
                <div className="resource-card-subtitle">{chat.chatId}</div>
              </div>
              <div className="resource-pill" data-status={chat.status}>
                {chatSubtitle(chat)}
              </div>
            </div>

            <div className="resource-field">
              <span className="resource-field-label">Task</span>
              <span className="resource-field-value">{chat.task}</span>
            </div>

            <dl className="resource-grid">
              <div>
                <dt className="resource-field-label">Intentos</dt>
                <dd className="resource-field-value">{chat.attempts}/{chat.maxRetries}</dd>
              </div>
              <div>
                <dt className="resource-field-label">Actualizado</dt>
                <dd className="resource-field-value">{formatTimestamp(chat.updatedAt)}</dd>
              </div>
              <div>
                <dt className="resource-field-label">Creado</dt>
                <dd className="resource-field-value">{formatTimestamp(chat.createdAt)}</dd>
              </div>
              <div>
                <dt className="resource-field-label">Resultado</dt>
                <dd className="resource-field-value">{chat.result ? "Disponible" : chat.error ? "Error" : "Pendiente"}</dd>
              </div>
            </dl>

            {(chat.result || chat.error || chat.context) && (
              <div className="resource-pre">
                {chat.context && <div><strong>Contexto:</strong> {chat.context}</div>}
                {chat.result && <div><strong>Resultado:</strong> {chat.result}</div>}
                {chat.error && <div><strong>Error:</strong> {chat.error}</div>}
              </div>
            )}
          </article>
        ))}
        </div>
      </div>
    </section>
  );
}
