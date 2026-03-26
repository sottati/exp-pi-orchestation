import { Moon, Sun } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";
import { useRuntime } from "../runtime-context";

const NAV_ITEMS = [
  { to: "/", label: "chat", end: true },
  { to: "/traces", label: "traces" },
  { to: "/agents", label: "agents" },
  { to: "/chats", label: "chats" },
  { to: "/jobs", label: "jobs" },
];

export function AppNav() {
  const { themeMode, setThemeMode } = useRuntime();

  return (
    <nav
      className="flex items-center gap-2 overflow-x-auto border-b border-theme-border bg-theme-panel px-4 py-2.5"
      aria-label="Primary"
    >
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "inline-flex min-h-7 items-center whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-muted transition-colors hover:bg-theme-hover hover:text-theme-secondary",
              isActive && "border-theme-text text-theme-text",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
      <div className="ml-auto flex items-center gap-2 pl-2">
        <button
          type="button"
          onClick={() => setThemeMode("light")}
          className={cn(
            "inline-flex min-h-7 items-center gap-1 whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-muted transition-colors hover:bg-theme-hover hover:text-theme-secondary",
            themeMode === "light" && "border-theme-text text-theme-text",
          )}
          aria-pressed={themeMode === "light"}
        >
          <Sun className="size-3.5" />
          light
        </button>
        <button
          type="button"
          onClick={() => setThemeMode("dark")}
          className={cn(
            "inline-flex min-h-7 items-center gap-1 whitespace-nowrap border border-theme-border px-2.5 text-[10px] uppercase tracking-[0.08em] text-theme-muted transition-colors hover:bg-theme-hover hover:text-theme-secondary",
            themeMode === "dark" && "border-theme-text text-theme-text",
          )}
          aria-pressed={themeMode === "dark"}
        >
          <Moon className="size-3.5" />
          dark
        </button>
      </div>
    </nav>
  );
}
