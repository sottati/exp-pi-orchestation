import { DithieSprite } from "../../dithie-sprite";
import { cn } from "../../lib/utils";
import type { UIMessage } from "../../ui-state";

export function EmptyState() {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center gap-4 text-center text-[12px] text-theme-border-subdued">
      <DithieSprite size={64} state="idle" />
      <span>send a message to start</span>
    </div>
  );
}

export function MessageBubble({ msg }: { msg: UIMessage }) {
  const containerClassName = cn(
    "flex max-w-[85%] flex-col gap-1",
    msg.role === "user" ? "self-end" : "self-start",
  );

  const contentClassName = cn(
    "rounded-[2px] border border-theme-border bg-theme-surface px-[14px] py-[10px] font-mono text-[13px] leading-[1.65] whitespace-pre-wrap break-words",
    msg.role === "user" && "border-r-2 border-l border-r-theme-text text-right",
    msg.role === "assistant" && "border-l-2 border-r border-l-theme-text",
    msg.role === "error" && "border-l-2 border-r border-l-theme-border-subdued text-theme-button-foreground",
  );

  const duration =
    msg.durationMs !== undefined ? (
      <span className="shrink-0 text-[10px] font-normal tabular-nums tracking-normal text-theme-text-soft normal-case">
        {(msg.durationMs / 1000).toFixed(1)}s
      </span>
    ) : null;

  const labelRowClass = cn(
    "flex min-w-0 flex-row flex-nowrap items-center gap-1.5 px-[2px] text-[10px] uppercase leading-none tracking-[0.06em]",
    msg.role === "user" && "justify-end",
  );

  return (
    <div className={containerClassName} id={msg.role === "user" ? `msg-${msg.id}` : undefined}>
      <div className={labelRowClass}>
        {msg.role === "user" ? (
          <>
            <span className="text-theme-text">YOU</span>
            {duration}
          </>
        ) : msg.role === "assistant" ? (
          <>
            <DithieSprite size={16} state="idle" />
            <span className="text-theme-text">DITHIE</span>
            {duration}
          </>
        ) : (
          <>
            <span className="text-theme-text">ERROR</span>
            {duration}
          </>
        )}
      </div>
      <pre className={contentClassName}>{msg.content}</pre>
    </div>
  );
}

export function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex max-w-[85%] flex-col gap-1 self-start">
      <div className="flex flex-row flex-nowrap items-center gap-1.5 px-[2px] text-[10px] uppercase leading-none tracking-[0.06em]">
        <DithieSprite size={16} state="thinking" />
        <span className="text-theme-text">DITHIE</span>
      </div>
      <pre className="rounded-[2px] border border-r border-l-2 border-theme-border border-l-theme-text bg-theme-surface px-[14px] py-[10px] font-mono text-[13px] leading-[1.65] whitespace-pre-wrap break-words opacity-90">
        {content}
        <span className="inline-block animate-blink-cursor">{"\u2588"}</span>
      </pre>
    </div>
  );
}
