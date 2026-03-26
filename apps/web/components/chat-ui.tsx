import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime, type RuntimeState } from "../runtime-context";
import type { DelegationBlock, UIMessage } from "../ui-state";
import { cn } from "../lib/utils";

function EmptyState() {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center gap-4 text-center text-[12px] text-[var(--theme-border-subdued)]">
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
    "rounded-[2px] border border-[var(--theme-border)] bg-[var(--theme-background-modal)] px-[14px] py-[10px] font-mono text-[13px] leading-[1.65] whitespace-pre-wrap break-words",
    msg.role === "user" && "border-r-2 border-l border-r-[var(--theme-text)] text-right",
    msg.role === "assistant" && "border-l-2 border-r border-l-[var(--theme-text)]",
    msg.role === "error" && "border-l-2 border-r border-l-[var(--theme-border-subdued)] text-[var(--theme-button-foreground)]",
  );

  return (
    <div className={containerClassName}>
      <div
        className={cn(
          "px-[2px] text-[10px] uppercase tracking-[0.06em] text-[var(--theme-border-subdued)]",
          msg.role === "user" && "text-right",
        )}
      >
        {msg.role === "user" ? (
          "YOU"
        ) : msg.role === "assistant" ? (
          <>
            <DithieSprite size={16} state="idle" /> DITHIE
          </>
        ) : (
          "ERROR"
        )}
        {msg.durationMs !== undefined && (
          <span className="ml-1 text-[9px] text-[var(--theme-border-subdued)]">
            {(msg.durationMs / 1000).toFixed(1)}s
          </span>
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
      <span className="animate-[dot-pulse_1s_ease-in-out_infinite] text-[11px] uppercase tracking-[0.08em] text-[var(--theme-border-subdued)]">
        thinking
      </span>
    </div>
  );
}

function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex max-w-[85%] flex-col gap-1 self-start">
      <div className="px-[2px] text-[10px] uppercase tracking-[0.06em] text-[var(--theme-border-subdued)]">
        <DithieSprite size={16} state="thinking" /> DITHIE
      </div>
      <pre className="rounded-[2px] border border-r border-l-2 border-[var(--theme-border)] border-l-[var(--theme-text)] bg-[var(--theme-background-modal)] px-[14px] py-[10px] font-mono text-[13px] leading-[1.65] whitespace-pre-wrap break-words opacity-90">
        {content}
        <span className="inline-block animate-[blink-cursor_0.6s_step-end_infinite]">{"\u2588"}</span>
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
    <div className="my-1 rounded-[2px] border border-dashed border-[var(--theme-border)] text-[11px]">
      <div
        className="flex cursor-pointer flex-row items-center gap-[6px] px-[10px] py-[6px] select-none hover:bg-[var(--theme-background-input)]"
        onClick={onToggle}
      >
        <span
          className={cn(
            "inline-block text-[10px] text-[var(--theme-border-subdued)] transition-transform duration-150 ease-in-out",
            expanded && "rotate-90",
          )}
        >
          {"\u25B8"}
        </span>
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--theme-border-subdued)]">
          dithie &rarr; {delegation.toAgentId}: &quot;{taskPreview}&quot;{durationLabel}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-dashed border-[var(--theme-border)] px-[10px] py-2 text-[11px] text-[var(--theme-border-subdued)]">
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
    <div className="flex h-[var(--input-h)] shrink-0 items-center gap-2 border-t border-[var(--theme-border)] bg-[var(--theme-background-modal)] px-4 py-3">
      <span
        className={cn(
          "shrink-0 self-center font-mono text-[13px] text-[var(--theme-border-subdued)]",
          state.isStreaming && "animate-[dot-pulse_1s_ease-in-out_infinite]",
        )}
      >
        {">_"}
      </span>
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-border-subdued)] disabled:cursor-not-allowed disabled:text-[var(--theme-border-subdued)]"
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
