import type { AgentChat } from "../../../packages/core/contracts";
import { statusBadgeClassName } from "../lib/agent-colors";
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-theme-border bg-theme-surface-panel px-5 pt-4 pb-3">
        <div>
          <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">delegations</div>
          <div className="text-[11px] text-theme-border-subdued">
            Estado de chats internos entre el orquestador y especialistas.
          </div>
        </div>
        <div
          className={statusBadgeClassName(state.chats.length > 0 ? "active" : "closed")}
          data-status={state.chats.length > 0 ? "active" : "closed"}
        >
          {state.chats.length} total
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-2.5 p-4 pt-4 pr-5 pb-5 pl-5">
        {state.chats.length === 0 && (
          <div className="px-5 py-[18px] text-[12px] text-theme-border-subdued">
            No hay chats delegados registrados todavia.
          </div>
        )}

        {state.chats.map((chat) => (
          <article
            key={chat.chatId}
            className="flex flex-col gap-2.5 border border-theme-border bg-theme-surface px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.08em] text-theme-text">{chat.agentId}</div>
                <div className="break-words text-[11px] text-theme-border-subdued">{chat.chatId}</div>
              </div>
              <div className={statusBadgeClassName(chat.status)} data-status={chat.status}>
                {chatSubtitle(chat)}
              </div>
            </div>

            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Task</span>
              <span className="break-words text-[12px] text-theme-text">{chat.task}</span>
            </div>

            <dl className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-3 gap-y-2">
              <div>
                <dt className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Intentos</dt>
                <dd className="break-words text-[12px] text-theme-text">{chat.attempts}/{chat.maxRetries}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Actualizado</dt>
                <dd className="break-words text-[12px] text-theme-text">{formatTimestamp(chat.updatedAt)}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Creado</dt>
                <dd className="break-words text-[12px] text-theme-text">{formatTimestamp(chat.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">Resultado</dt>
                <dd className="break-words text-[12px] text-theme-text">
                  {chat.result ? "Disponible" : chat.error ? "Error" : "Pendiente"}
                </dd>
              </div>
            </dl>

            {(chat.result || chat.error || chat.context) && (
              <div className="break-words border-t border-dashed border-theme-border pt-2.5 font-mono text-[12px] whitespace-pre-wrap text-theme-button-foreground">
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
