import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RuntimeState } from "../runtime-context";
import { decideChatScrollAction } from "./chat-scroll";
import { DelegationBlockComponent } from "./ui/chat-delegation";
import { EmptyState, MessageBubble, StreamingBubble } from "./ui/chat-message";
import { ThinkingTraceBlockComponent } from "./ui/chat-thinking";

const LAST_TURN_MIN_HEIGHT = "calc(100% - 7rem)";
const LAST_TURN_PADDING_BOTTOM = "2.5rem";

export function ChatPanel({
  state,
  onToggleDelegation,
  pendingAnchorUserMessageId,
  clearPendingAnchorUserMessage,
}: {
  state: RuntimeState;
  onToggleDelegation: (delegationId: string) => void;
  pendingAnchorUserMessageId: string | null;
  clearPendingAnchorUserMessage: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const wasStreamingRef = useRef(false);
  const justEndedStreamingRef = useRef(false);
  const previousRunIdRef = useRef<string | null>(null);
  const anchoredRunIdRef = useRef<string | null>(null);

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

  useLayoutEffect(() => {
    if (!state.isStreaming || !state.currentRunId) return;
    const action = decideChatScrollAction({
      isStreaming: state.isStreaming,
      pendingAnchorUserMessageId,
      anchoredRunInProgress: false,
      justEndedStreaming: false,
      wasNearBottom: false,
    });
    if (action !== "anchor-to-top") return;

    const container = listRef.current;
    const target = document.getElementById(`msg-${pendingAnchorUserMessageId}`);
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, targetRect.top - containerRect.top + container.scrollTop - 12);
    container.scrollTo({ top, behavior: "smooth" });
    anchoredRunIdRef.current = state.currentRunId;
    clearPendingAnchorUserMessage();
  }, [
    clearPendingAnchorUserMessage,
    pendingAnchorUserMessageId,
    state.currentRunId,
    state.isStreaming,
    state.chatItems.length,
  ]);

  useEffect(() => {
    const previousRunId = previousRunIdRef.current;
    if (wasStreamingRef.current && !state.isStreaming) {
      justEndedStreamingRef.current = Boolean(previousRunId && anchoredRunIdRef.current === previousRunId);
      if (previousRunId && anchoredRunIdRef.current === previousRunId) {
        anchoredRunIdRef.current = null;
      }
    }
    wasStreamingRef.current = state.isStreaming;
    previousRunIdRef.current = state.currentRunId;
  }, [state.currentRunId, state.isStreaming]);

  useEffect(() => {
    if (!state.isStreaming) {
      wasNearBottomRef.current = isNearBottom();
    }
  }, [isNearBottom, state.isStreaming]);

  useEffect(() => {
    const anchoredRunInProgress = Boolean(
      state.isStreaming
      && state.currentRunId
      && anchoredRunIdRef.current === state.currentRunId,
    );
    const action = decideChatScrollAction({
      isStreaming: state.isStreaming,
      pendingAnchorUserMessageId,
      anchoredRunInProgress,
      justEndedStreaming: justEndedStreamingRef.current,
      wasNearBottom: wasNearBottomRef.current,
    });

    if (action === "skip-after-stream-end") {
      justEndedStreamingRef.current = false;
      return;
    }

    if (action === "scroll-to-bottom") {
      scrollToBottom();
    }
  }, [pendingAnchorUserMessageId, scrollToBottom, state.chatItems.length, state.currentRunId, state.isStreaming, state.streamBuffer]);

  const isEmpty = state.chatItems.length === 0 && !state.isStreaming;

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <EmptyState />
      </div>
    );
  }

  const showThinkingSpacer = state.isStreaming && state.streamBuffer === "";

  return (
    <div
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-thin"
      ref={listRef}
    >
      <div className="flex min-h-full flex-col gap-3 pb-8">
        {state.chatItems.map((item, index) => {
          const isLastChatItem = index === state.chatItems.length - 1;
          const isAnchoredAssistantTurn = isLastChatItem && !state.isStreaming && item.kind === "message" && item.message.role === "assistant";

          if (item.kind === "message") {
            const message = <MessageBubble key={item.message.id} msg={item.message} />;
            if (!isAnchoredAssistantTurn) return message;
            return (
              <div
                key={`turn-${item.message.id}`}
                className="flex flex-col justify-start"
                style={{ minHeight: LAST_TURN_MIN_HEIGHT, paddingBottom: LAST_TURN_PADDING_BOTTOM }}
              >
                {message}
              </div>
            );
          }

          if (item.kind === "thinking_trace") {
            const block = state.thinkingTraces[item.runId];
            if (!block) return null;
            
            if (block.status !== "running" && block.lines.length === 1 && block.lines[0] === "thinking...") {
              return null;
            }

            return (
              <ThinkingTraceBlockComponent
                key={`thinking-${item.runId}`}
                block={block}
              />
            );
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
        {state.isStreaming && state.streamBuffer !== "" && (
          <div
            className="flex flex-col justify-start"
            style={{ minHeight: LAST_TURN_MIN_HEIGHT, paddingBottom: LAST_TURN_PADDING_BOTTOM }}
          >
            <StreamingBubble content={state.streamBuffer} />
          </div>
        )}
        {showThinkingSpacer && (
          <div className="min-h-[calc(100vh-var(--header-h)-var(--input-h)-80px)] flex-1" aria-hidden />
        )}
      </div>
    </div>
  );
}
