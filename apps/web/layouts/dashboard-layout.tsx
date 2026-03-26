import { NavLink, Outlet, useLocation } from "react-router-dom";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime } from "../runtime-context";
import { InputBar } from "../components/chat-ui";
import { AppNav } from "../components/nav";

function Header() {
  const { state } = useRuntime();

  return (
    <div className="flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-theme-border bg-theme-surface px-4">
      <div className="flex h-full min-h-0 items-center gap-2.5">
        <NavLink
          className="inline-flex h-full min-h-0 items-center gap-2.5 leading-none text-inherit no-underline"
          to="/"
        >
          <DithieSprite size={32} state={state.dithieState} />
          <span className="select-none text-[11px] leading-none uppercase tracking-[0.14em] text-theme-text">
            dithie
          </span>
          <span className="text-[10px] leading-none text-theme-text-soft">{state.dithieState}</span>
        </NavLink>
      </div>
      <div className="ml-auto flex h-full items-center gap-2.5 leading-none">
        {state.sessionId && (
          <span className="text-[10px] leading-none text-theme-text-soft">
            session: {state.sessionId}
          </span>
        )}
        <span
          className={`select-none text-[10px] leading-none ${state.wsConnected
              ? "text-theme-text-soft"
              : "text-theme-text-muted"
            }`}
        >
          {state.wsConnected ? "\u25CF connected" : "\u25CB disconnected"}
        </span>
      </div>
    </div>
  );
}

export function DashboardLayout() {
  const location = useLocation();
  const { state, respondToHitl } = useRuntime();
  const showChatInput = location.pathname === "/";
  const activeHitlRequest = state.hitlQueue[0];

  return (
    <div className="flex h-full flex-col">
      <Header />
      <AppNav />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      {showChatInput && <InputBar />}
      {activeHitlRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex w-full max-w-2xl flex-col gap-3 border border-theme-border bg-theme-surface p-4 shadow-2xl">
            <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">approval required</div>
            <div className="text-[12px] text-theme-text-soft">
              {activeHitlRequest.agentId} wants to run <code>{activeHitlRequest.toolName}</code>.
            </div>
            {activeHitlRequest.reason && (
              <div className="text-[12px] text-theme-text-soft">{activeHitlRequest.reason}</div>
            )}
            <div className="flex gap-3 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted">
              <span>timeout: {Math.max(1, Math.floor(activeHitlRequest.timeout / 1000))}s</span>
              {state.hitlQueue.length > 1 && <span>pending: {state.hitlQueue.length}</span>}
            </div>
            <div className="text-[10px] uppercase tracking-[0.08em] text-theme-text-muted">params</div>
            <pre className="max-h-72 overflow-auto border border-theme-border bg-theme-input p-3 text-[12px] whitespace-pre-wrap break-words text-theme-text">
              {JSON.stringify(activeHitlRequest.params, null, 2)}
            </pre>
            <div className="flex justify-end gap-2 max-sm:flex-col">
              <button
                type="button"
                className="border border-theme-text px-3 py-2 text-[12px] text-theme-text hover:bg-theme-surface-hover"
                onClick={() => respondToHitl(activeHitlRequest.reqId, true)}
              >
                Allow (y)
              </button>
              <button
                type="button"
                className="border border-theme-border-subdued px-3 py-2 text-[12px] text-theme-text-soft hover:bg-theme-surface-hover"
                onClick={() => respondToHitl(activeHitlRequest.reqId, false)}
              >
                Don&apos;t Allow (n)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
