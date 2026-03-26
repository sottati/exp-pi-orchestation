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
  const showChatInput = location.pathname === "/";

  return (
    <div className="flex h-full flex-col">
      <Header />
      <AppNav />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      {showChatInput && <InputBar />}
    </div>
  );
}
