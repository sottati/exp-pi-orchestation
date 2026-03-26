import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "chat", end: true },
  { to: "/traces", label: "traces" },
  { to: "/agents", label: "agents" },
  { to: "/chats", label: "chats" },
  { to: "/jobs", label: "jobs" },
];

export function AppNav() {
  return (
    <nav className="top-nav" aria-label="Primary">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `top-nav-link${isActive ? " top-nav-link--active" : ""}`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
