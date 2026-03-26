import React, { useState } from "react";
import { DithieSprite } from "./dithie-sprite";
import { SidebarSpiderIcon } from "./sidebar-spider";
import type { AgentInfo, DithieState, ViewTarget } from "./types";

interface SidebarProps {
  agents: AgentInfo[];
  activeView: ViewTarget;
  onSelectView: (view: ViewTarget) => void;
  dithieState: DithieState;
  busyAgents: Set<string>;
}

export function Sidebar({ agents, activeView, onSelectView, dithieState, busyAgents }: SidebarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const specialistAgents = agents.filter((agent) => agent.id !== "orchestrator");

  return (
    <div className="sidebar">
      <div
        className={`sidebar-item agent-accent--orchestrator${activeView === "home" ? " sidebar-item--active" : ""}`}
        onClick={() => onSelectView("home")}
        onMouseEnter={() => setHoveredId("home")}
        onMouseLeave={() => setHoveredId(null)}
      >
        <DithieSprite size={32} state={dithieState} />
        {hoveredId === "home" && <div className="sidebar-tooltip">dithie (home)</div>}
      </div>

      <div className="sidebar-divider" />

      {specialistAgents.map((agent) => {
        const isActive = activeView === agent.id;
        const isBusy = busyAgents.has(agent.id);

        return (
          <div
            key={agent.id}
            className={`sidebar-item agent-accent--${agent.id}${isActive ? " sidebar-item--active" : ""}`}
            onClick={() => onSelectView(agent.id)}
            onMouseEnter={() => setHoveredId(agent.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <SidebarSpiderIcon agentId={agent.id} size={22} />
            <div className={`sidebar-status sidebar-status--${isBusy ? "busy" : "idle"}`} />
            {hoveredId === agent.id && (
              <div className="sidebar-tooltip">{agent.name}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
