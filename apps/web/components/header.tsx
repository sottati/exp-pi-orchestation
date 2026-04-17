import { LogOut, Moon, Sun } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { cn } from "../lib/utils";
import { useRuntime } from "../runtime-context";
import { DithieSprite } from "../dithie-sprite";
import { getSupabaseBrowserClient } from "../supabase-browser";

const NAV_ITEMS = [
  { to: "/", label: "chat", end: true },
  { to: "/traces", label: "traces" },
  { to: "/agents", label: "agents" },
  { to: "/chats", label: "chats" },
  { to: "/jobs", label: "jobs" },
];

export function AppHeader() {
  const { state, themeMode, setThemeMode } = useRuntime();
  const navigate = useNavigate();

  const signOut = async () => {
    const client = await getSupabaseBrowserClient();
    if (client) {
      await client.auth.signOut();
    }
    window.localStorage.removeItem("PI_AUTH_TOKEN");
    navigate("/login", { replace: true });
  };

  return (
    <header className="flex h-[var(--header-h)] shrink-0 items-center justify-between border-b border-theme-border bg-theme-surface px-4">
      {/* Left */}
      <div className="flex flex-1 min-w-0 items-center gap-2.5 overflow-hidden justify-start">
        <NavLink
          className="inline-flex h-full min-h-0 items-center gap-2.5 leading-none text-inherit no-underline shrink-0"
          to="/"
        >
          <DithieSprite size={32} state={state.dithieState} />
          <span className="select-none text-[11px] leading-none uppercase tracking-[0.14em] text-theme-text max-sm:hidden">
            dithie
          </span>
          <span className="text-[10px] leading-none text-theme-text-soft max-sm:hidden">{state.dithieState}</span>
        </NavLink>
      </div>

      {/* Middle */}
      <nav className="flex items-center justify-center gap-2 overflow-x-auto shrink-0 px-4 max-sm:flex-1 max-sm:justify-start max-sm:px-1" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "inline-flex min-h-7 items-center whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text-soft",
                isActive && "border-theme-text text-theme-text",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Right */}
      <div className="flex flex-1 min-w-0 items-center justify-end gap-2 shrink-0 overflow-hidden">
        <div className="flex h-full items-center gap-3 leading-none truncate mr-2 max-sm:hidden">
          {state.orgId && (
            <span className="text-[10px] leading-none text-theme-text-soft max-md:hidden">
              org: {state.orgId}
            </span>
          )}
          {state.sessionId && (
            <span className="text-[10px] leading-none text-theme-text-soft truncate max-lg:hidden">
              session: {state.sessionId}
            </span>
          )}
          <span
            className={cn(
              "select-none text-[10px] leading-none shrink-0",
              state.wsConnected ? "text-theme-text-soft" : "text-theme-text-muted",
            )}
          >
            {state.wsConnected ? "\u25CF connected" : "\u25CB disconnected"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setThemeMode("light")}
          className={cn(
            "inline-flex min-h-7 items-center gap-1 whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text-soft",
            themeMode === "light" && "border-theme-text text-theme-text",
          )}
          aria-pressed={themeMode === "light"}
        >
          <Sun className="size-3.5" />
          <span className="max-sm:hidden">light</span>
        </button>
        <button
          type="button"
          onClick={() => setThemeMode("dark")}
          className={cn(
            "inline-flex min-h-7 items-center gap-1 whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text-soft",
            themeMode === "dark" && "border-theme-text text-theme-text",
          )}
          aria-pressed={themeMode === "dark"}
        >
          <Moon className="size-3.5" />
          <span className="max-sm:hidden">dark</span>
        </button>
        <button
          type="button"
          onClick={() => {
            void signOut();
          }}
          className="inline-flex min-h-7 items-center gap-1 whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text-soft"
          aria-label="Sign out"
        >
          <LogOut className="size-3.5" />
          <span className="max-sm:hidden">logout</span>
        </button>
      </div>
    </header>
  );
}
