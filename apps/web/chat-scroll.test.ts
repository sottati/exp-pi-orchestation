import { describe, expect, test } from "bun:test";
import { decideChatScrollAction } from "./components/chat-scroll";
import { extractThinkingHeadingText, splitThinkingTitle, visibleThinkingLines } from "./components/ui/chat-thinking";

describe("decideChatScrollAction", () => {
  test("anchors immediately when a user message is pending even before streaming starts", () => {
    const action = decideChatScrollAction({
      isStreaming: false,
      pendingAnchorUserMessageId: "user-123",
      anchoredRunInProgress: false,
      justEndedStreaming: false,
      wasNearBottom: true,
    });

    expect(action).toBe("anchor-to-top");
  });

  test("returns anchor-to-top when user just sent a message and streaming started", () => {
    const action = decideChatScrollAction({
      isStreaming: true,
      pendingAnchorUserMessageId: "user-123",
      anchoredRunInProgress: false,
      justEndedStreaming: false,
      wasNearBottom: true,
    });

    expect(action).toBe("anchor-to-top");
  });

  test("skips auto-scroll right after streaming ends following an anchor", () => {
    const action = decideChatScrollAction({
      isStreaming: false,
      pendingAnchorUserMessageId: null,
      anchoredRunInProgress: false,
      justEndedStreaming: true,
      wasNearBottom: true,
    });

    expect(action).toBe("skip-after-stream-end");
  });

  test("keeps normal auto-scroll to bottom when user is near bottom and no anchor is pending", () => {
    const action = decideChatScrollAction({
      isStreaming: false,
      pendingAnchorUserMessageId: null,
      anchoredRunInProgress: false,
      justEndedStreaming: false,
      wasNearBottom: true,
    });

    expect(action).toBe("scroll-to-bottom");
  });

  test("does not auto-scroll when user moved away from bottom and no anchor is pending", () => {
    const action = decideChatScrollAction({
      isStreaming: false,
      pendingAnchorUserMessageId: null,
      anchoredRunInProgress: false,
      justEndedStreaming: false,
      wasNearBottom: false,
    });

    expect(action).toBe("none");
  });
});

describe("anchored run scroll behavior", () => {
  test("does not auto-scroll while anchored run is streaming", () => {
    const action = decideChatScrollAction({
      isStreaming: true,
      pendingAnchorUserMessageId: null,
      anchoredRunInProgress: true,
      justEndedStreaming: false,
      wasNearBottom: true,
    });
    expect(action).toBe("none");
  });
});

describe("visibleThinkingLines", () => {
  test("shows all lines when collapsed for debugging", () => {
    const lines = ["1", "2", "3", "4", "5"];
    expect(visibleThinkingLines(lines, true)).toEqual(lines);
  });

  test("shows all lines when expanded", () => {
    const lines = ["1", "2", "3", "4"];
    expect(visibleThinkingLines(lines, false)).toEqual(lines);
  });
});

describe("splitThinkingTitle", () => {
  test("extracts markdown bold title from first line", () => {
    expect(splitThinkingTitle(["**Explaining technical terms**", "line 1", "line 2"])).toEqual({
      title: "Explaining technical terms",
      bodyLines: ["line 1", "line 2"],
    });
  });

  test("keeps full content in body when first line is not a title", () => {
    expect(splitThinkingTitle(["line 1", "line 2"])).toEqual({
      bodyLines: ["line 1", "line 2"],
    });
  });
});

describe("extractThinkingHeadingText", () => {
  test("extracts bold markdown section titles", () => {
    expect(extractThinkingHeadingText("**Planning UI changes**")).toBe("Planning UI changes");
  });

  test("extracts hash heading section titles", () => {
    expect(extractThinkingHeadingText("## Planning UI changes")).toBe("Planning UI changes");
  });

  test("ignores normal prose lines", () => {
    expect(extractThinkingHeadingText("I should inspect the current component")).toBeUndefined();
  });
});
