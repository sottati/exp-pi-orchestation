import { cn } from "../../lib/utils";
import type { DelegationBlock } from "../../ui-state";

export function DelegationBlockComponent({
  delegation,
  expanded,
  onToggle,
}: {
  delegation: DelegationBlock;
  expanded: boolean;
  onToggle: () => void;
}) {
  const taskPreview = delegation.task.length > 60
    ? delegation.task.slice(0, 60) + "\u2026"
    : delegation.task;

  const durationLabel = delegation.durationMs !== undefined
    ? ` ${(delegation.durationMs / 1000).toFixed(1)}s`
    : "";

  return (
    <div className="my-1 rounded-[2px] border border-dashed border-theme-border text-[11px]">
      <div
        className="flex cursor-pointer flex-row items-center gap-[6px] px-[10px] py-[6px] select-none hover:bg-theme-input"
        onClick={onToggle}
      >
        <span
          className={cn(
            "inline-block text-[10px] text-theme-border-subdued transition-transform duration-150 ease-in-out",
            expanded && "rotate-90",
          )}
        >
          {"\u25B8"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] leading-snug text-theme-text-soft">
          <span className="text-theme-text-muted">dithie &rarr;</span>{" "}
          <span className="font-medium text-theme-text">{delegation.toAgentId}</span>
          <span className="text-theme-text-soft">: &quot;{taskPreview}&quot;{durationLabel}</span>
        </span>
      </div>
      {expanded && (
        <div className="border-t border-dashed border-theme-border px-[10px] py-2 text-[11px] text-theme-border-subdued">
          <div><strong>Task:</strong> {delegation.task}</div>
          {delegation.result && <div><strong>Result:</strong> {delegation.result}</div>}
          <div><strong>Status:</strong> {delegation.status}</div>
        </div>
      )}
    </div>
  );
}
