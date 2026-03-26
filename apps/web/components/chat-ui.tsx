import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { DithieSprite } from "../dithie-sprite";
import { useRuntime, type RuntimeState } from "../runtime-context";
import type { DelegationBlock, UIMessage } from "../ui-state";

function EmptyState() {
  return (
    <div className="empty-state">
      <DithieSprite size={64} state="idle" />
      <span>send a message to start</span>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UIMessage }) {
  const classNames = `message message--${msg.role === "assistant" ? "dithie" : msg.role}`;

  return (
    <div className={classNames}>
      <div className="message-meta">
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
          <span className="message-duration">{(msg.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <pre className="message-content">{msg.content}</pre>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="thinking-row" aria-live="polite" aria-busy="true">
      <DithieSprite size={32} state="thinking" />
      <span className="thinking-row-label">thinking</span>
    </div>
  );
}

function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="message message--dithie streaming">
      <div className="message-meta">
        <DithieSprite size={16} state="thinking" /> DITHIE
      </div>
      <pre className="message-content">
        {content}
        <span className="streaming-cursor">{"\u2588"}</span>
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
    <div className={`delegation-block delegation-status--${delegation.status}`}>
      <div className="delegation-header" onClick={onToggle}>
        <span className={`delegation-arrow${expanded ? " expanded" : ""}`}>{"\u25B8"}</span>
        <span className="delegation-label">
          dithie &rarr; {delegation.toAgentId}: &quot;{taskPreview}&quot;{durationLabel}
        </span>
      </div>
      {expanded && (
        <div className="delegation-body">
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
      <div className="chat-panel">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="message-list" ref={listRef}>
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
    <div className={`input-bar${state.isStreaming ? " input-bar--disabled" : ""}`}>
      <span className="input-prompt">{">_"}</span>
      <input
        ref={inputRef}
        className="input-field"
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
