import { useCallback, useEffect, useRef } from "react";
import type { TraceEvent } from "../../../packages/core/contracts";
import { cn } from "../lib/utils";

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
  let statusClassName = "";

  if (trace.status === "ok" || trace.status === "completed") {
    statusPrefix = "\u2713 ";
  } else if (trace.status === "error") {
    statusPrefix = "\u2717 ";
  } else if (trace.status === "cancelled") {
    statusClassName = "line-through";
  }

  const durationLabel = duration !== undefined ? `${(duration / 1000).toFixed(1)}s` : "";

  return (
    <>
      <div
        className={cn(
          "flex cursor-pointer flex-row items-baseline gap-1.5 border-l-2 border-transparent px-2.5 py-1 text-[11px] leading-[1.4] transition-colors hover:bg-theme-input",
          expanded && "border-l-theme-text",
          statusClassName,
        )}
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1 truncate text-theme-text">
          {statusPrefix}{trace.type}
        </span>
        {trace.agentId && (
          <span className="max-w-[70px] shrink-0 truncate text-[10px] text-theme-border-subdued">
            {trace.agentId}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-theme-border-subdued">{trace.status}</span>
        {durationLabel && <span className="shrink-0 text-[10px] text-theme-border-subdued">{durationLabel}</span>}
      </div>
      {expanded && trace.details && (
        <div className="break-all border-l-2 border-theme-border-subdued px-2.5 py-1.5 pl-5 text-[10px] text-theme-border-subdued">
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
    <div className={cn(
      "flex min-h-0 flex-col overflow-hidden border-l border-theme-border",
      variant === "sidebar" ? "w-[var(--trace-w)] shrink-0" : "w-full border-l-0",
    )}>
      <div className="shrink-0 border-b border-theme-border px-3 py-2.5 text-[10px] uppercase tracking-[0.12em] text-theme-border-subdued">
        {title}
      </div>
      <div
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-0 py-1.5 [scrollbar-color:var(--color-theme-border)_transparent]"
        ref={listRef}
      >
        {traces.length === 0 && <div className="px-3 py-3 text-[11px] text-theme-border-subdued">no traces yet</div>}
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
