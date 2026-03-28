import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRuntime } from "../../runtime-context";
import { cn } from "../../lib/utils";

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
