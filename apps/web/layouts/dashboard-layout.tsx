import { NavLink, Outlet } from "react-router-dom";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime } from "../runtime-context";
import { InputBar } from "../components/chat-ui";
import { AppNav } from "../components/nav";

function Header() {
  const { state } = useRuntime();

  return (
    <div className="header">
      <div className="header-left">
        <NavLink className="header-brand" to="/">
          <DithieSprite size={32} state={state.dithieState} />
          <span className="header-label">dithie</span>
          <span className="header-state">{state.dithieState}</span>
        </NavLink>
      </div>
      <div className="header-right">
        {state.sessionId && <span className="header-session">session: {state.sessionId}</span>}
        <span className={`header-ws-indicator ${state.wsConnected ? "header-ws-indicator--connected" : "header-ws-indicator--disconnected"}`}>
          {state.wsConnected ? "\u25CF connected" : "\u25CB disconnected"}
        </span>
      </div>
    </div>
  );
}

export function DashboardLayout() {
  const { state } = useRuntime();

  return (
    <div className="app">
      <Header />
      <AppNav />
      <div className="route-content">
        <Outlet />
      </div>
      <InputBar />
    </div>
  );
}
