export type ChatScrollAction = "anchor-to-top" | "skip-after-stream-end" | "scroll-to-bottom" | "none";

export interface ChatScrollDecisionInput {
  isStreaming: boolean;
  pendingAnchorUserMessageId: string | null;
  anchoredRunInProgress: boolean;
  justEndedStreaming: boolean;
  wasNearBottom: boolean;
}

export function decideChatScrollAction(input: ChatScrollDecisionInput): ChatScrollAction {
  if (input.pendingAnchorUserMessageId) {
    return "anchor-to-top";
  }

  if (input.anchoredRunInProgress) {
    return "none";
  }

  if (input.isStreaming) {
    return "none";
  }

  if (input.justEndedStreaming) {
    return "skip-after-stream-end";
  }

  if (input.wasNearBottom) {
    return "scroll-to-bottom";
  }

  return "none";
}
