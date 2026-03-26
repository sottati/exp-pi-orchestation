import { useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { TraceEvent } from "../../../packages/core/contracts";

function TraceItem({
  trace,
  expanded,
  duration,
  onToggle,
}: {
  trace: TraceEvent;
  expanded: boolean;
  duration?: number;
  onToggle: () => void;
}) {
  let statusPrefix = "";
  let statusStyle: CSSProperties = {};

  if (trace.status === "ok" || trace.status === "completed") {
    statusPrefix = "\u2713 ";
  } else if (trace.status === "error") {
    statusPrefix = "\u2717 ";
  } else if (trace.status === "cancelled") {
    statusStyle = { textDecoration: "line-through" };
  }

  const durationLabel = duration !== undefined ? `${(duration / 1000).toFixed(1)}s` : "";

  return (
    <>
      <div
        className={`trace-item${expanded ? " expanded" : ""}`}
        onClick={onToggle}
        style={statusStyle}
      >
        <span className="trace-type">{statusPrefix}{trace.type}</span>
        {trace.agentId && <span className="trace-agent">{trace.agentId}</span>}
        <span className="trace-status">{trace.status}</span>
        {durationLabel && <span className="trace-duration">{durationLabel}</span>}
      </div>
      {expanded && trace.details && (
        <div className="trace-details">
          {Object.entries(trace.details).map(([key, value]) => (
            <div key={key}>{key}: {typeof value === "object" ? JSON.stringify(value) : String(value)}</div>
          ))}
          {trace.toolName && <div>tool: {trace.toolName}</div>}
        </div>
      )}
    </>
  );
}

export function TracePanel({
  traces,
  expandedTraces,
  traceDurations,
  onToggleTrace,
  title = "TRACES",
  variant = "sidebar",
}: {
  traces: TraceEvent[];
  expandedTraces: Set<string>;
  traceDurations: Record<string, number>;
  onToggleTrace: (eventId: string) => void;
  title?: string;
  variant?: "sidebar" | "page";
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const isNearBottom = useCallback(() => {
    const element = listRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 50;
  }, []);

  useEffect(() => {
    wasNearBottomRef.current = isNearBottom();
  });

  useEffect(() => {
    const element = listRef.current;
    if (element && wasNearBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [traces.length]);

  return (
    <div className={`trace-panel${variant === "page" ? " trace-panel--page" : ""}`}>
      <div className="trace-panel-title">{title}</div>
      <div className="trace-list" ref={listRef}>
        {traces.length === 0 && <div className="trace-empty">no traces yet</div>}
        {traces.map((trace) => (
          <TraceItem
            key={trace.eventId}
            trace={trace}
            expanded={expandedTraces.has(trace.eventId)}
            duration={traceDurations[trace.eventId]}
            onToggle={() => onToggleTrace(trace.eventId)}
          />
        ))}
      </div>
    </div>
  );
}
