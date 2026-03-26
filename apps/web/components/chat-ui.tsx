import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime, type RuntimeState } from "../runtime-context";
import type { DelegationBlock, UIMessage } from "../ui-state";
import { cn } from "../lib/utils";

function EmptyState() {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center gap-4 text-center text-[12px] text-theme-border-subdued">
      <DithieSprite size={64} state="idle" />
      <span>send a message to start</span>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UIMessage }) {
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
    <div className={containerClassName}>
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

function ThinkingRow() {
  return (
    <div
      className="flex select-none flex-row items-center gap-3 self-start px-1 pt-2 pb-3"
      aria-live="polite"
      aria-busy="true"
    >
      <DithieSprite size={32} state="thinking" />
      <span className="animate-dot-pulse text-[11px] uppercase tracking-[0.08em] text-theme-text-soft">
        thinking
      </span>
    </div>
  );
}

function StreamingBubble({ content }: { content: string }) {
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

function DelegationBlockComponent({
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

export function ChatPanel({
  state,
  onToggleDelegation,
}: {
  state: RuntimeState;
  onToggleDelegation: (delegationId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const isNearBottom = useCallback(() => {
    const element = listRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = listRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  useEffect(() => {
    wasNearBottomRef.current = isNearBottom();
  });

  useEffect(() => {
    if (wasNearBottomRef.current) {
      scrollToBottom();
    }
  }, [state.chatItems.length, state.streamBuffer, scrollToBottom]);

  const isEmpty = state.chatItems.length === 0 && !state.isStreaming;

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pt-5 pb-2 scrollbar-thin"
        ref={listRef}
      >
        {state.chatItems.map((item) => {
          if (item.kind === "message") {
            return <MessageBubble key={item.message.id} msg={item.message} />;
          }

          const delegation = state.delegations[item.delegationId];
          if (!delegation) return null;

          return (
            <DelegationBlockComponent
              key={item.delegationId}
              delegation={delegation}
              expanded={state.expandedDelegations.has(item.delegationId)}
              onToggle={() => onToggleDelegation(item.delegationId)}
            />
          );
        })}
        {state.isStreaming && (
          state.streamBuffer === "" ? (
            <ThinkingRow />
          ) : (
            <StreamingBubble content={state.streamBuffer} />
          )
        )}
      </div>
    </div>
  );
}

export function InputBar() {
  const { state, sendMessage } = useRuntime();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || state.isStreaming) return;
    const sent = sendMessage(trimmed);
    if (!sent) return;

    setValue("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [sendMessage, state.isStreaming, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-[var(--input-h)] shrink-0 items-center gap-2 border-t border-theme-border bg-theme-surface px-4 py-3">
      <span
        className={cn(
          "shrink-0 self-center font-mono text-[13px] text-theme-border-subdued",
          state.isStreaming && "animate-dot-pulse",
        )}
      >
        {">_"}
      </span>
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-theme-text outline-none placeholder:text-theme-border-subdued disabled:cursor-not-allowed disabled:text-theme-border-subdued"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={state.isStreaming ? "thinking..." : "message dithie..."}
        disabled={state.isStreaming}
        autoFocus
      />
    </div>
  );
}
