import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "chat", end: true },
  { to: "/traces", label: "traces" },
  { to: "/agents", label: "agents" },
  { to: "/chats", label: "chats" },
  { to: "/jobs", label: "jobs" },
];

export function AppNav() {
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
    </nav>
  );
}
