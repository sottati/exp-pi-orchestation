import { NavLink, Outlet } from "react-router-dom";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime } from "../runtime-context";
import { InputBar } from "../components/chat-ui";
import { AppNav } from "../components/nav";

function Header() {
  const { state } = useRuntime();

  return (
    <div className="flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-[color:var(--theme-border)] bg-[color:var(--theme-background-modal)] px-4">
      <div className="flex items-center gap-2.5">
        <NavLink className="inline-flex items-center gap-2.5 text-inherit no-underline" to="/">
          <DithieSprite size={32} state={state.dithieState} />
          <span className="select-none text-[11px] uppercase tracking-[0.14em] text-[color:var(--theme-border-subdued)]">dithie</span>
          <span className="text-[10px] text-[color:var(--theme-border-subdued)]">{state.dithieState}</span>
        </NavLink>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        {state.sessionId && (
          <span className="text-[10px] text-[color:var(--theme-border-subdued)]">
            session: {state.sessionId}
          </span>
        )}
        <span
          className={`select-none text-[10px] ${
            state.wsConnected
              ? "text-[color:var(--theme-text-soft)]"
              : "text-[color:var(--theme-border-subdued)]"
          }`}
        >
          {state.wsConnected ? "\u25CF connected" : "\u25CB disconnected"}
        </span>
      </div>
    </div>
  );
}

export function DashboardLayout() {
  const { state } = useRuntime();

  return (
    <div className="flex h-full flex-col">
      <Header />
      <AppNav />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      <InputBar />
    </div>
  );
}
