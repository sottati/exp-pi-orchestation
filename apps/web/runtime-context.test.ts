import { describe, expect, test } from "bun:test";
import { initialRuntimeState, runtimeReducer, type RuntimeAction, type RuntimeState } from "./runtime-context";

function freshState(): RuntimeState {
  return {
    ...initialRuntimeState,
    expandedTraces: new Set(),
    expandedDelegations: new Set(),
    messages: [],
    chatItems: [],
    traces: [],
    delegations: {},
    thinkingTraces: {},
    traceStartTimes: {},
    traceDurations: {},
    chats: [],
    jobs: [],
    hitlQueue: [],
  };
}

describe("runtimeReducer thinking traces", () => {
  test("chat_sending creates a placeholder thinking block and chat item", () => {
    const state = runtimeReducer(
      freshState(),
      { type: "chat_sending", runId: "run-1", toAgentId: "orchestrator" } as RuntimeAction,
    );

    expect(state.isStreaming).toBe(true);
    expect(state.currentRunId).toBe("run-1");
    expect(state.thinkingTraces["run-1"]).toMatchObject({
      runId: "run-1",
      lines: ["thinking..."],
      status: "running",
      collapsed: true,
      source: "tool",
      hasModelThinking: false,
    });
    expect(state.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(true);
  });

  test("stream_status appends lines to the correct run block", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_status", runId: "run-1", text: "→ tool_a" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_status", runId: "run-1", text: "→ tool_b" } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.status).toBe("running");
    expect(state2.thinkingTraces["run-1"]?.collapsed).toBe(true);
    expect(state2.thinkingTraces["run-1"]?.lines).toEqual(["→ tool_a", "→ tool_b"]);
    expect(state2.thinkingTraces["run-1"]?.source).toBe("tool");
    expect(state2.thinkingTraces["run-1"]?.hasModelThinking).toBe(false);
    expect(state2.chatItems.filter((item) => item.kind === "thinking_trace")).toHaveLength(1);
  });

  test("stream_status replaces placeholder line when first real status arrives", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "chat_sending", runId: "run-1", toAgentId: "orchestrator" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_status", runId: "run-1", text: "→ delegate → explorer" } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.lines).toEqual(["→ delegate → explorer"]);
  });

  test("stream_end closes the run block without removing it", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_status", runId: "run-1", text: "→ tool_a" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_end", runId: "run-1", answer: "ok", durationMs: 10 } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.status).toBe("completed");
    expect(state2.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(true);
  });

  test("thinking stream events append model lines in real time", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_thinking_start", runId: "run-1" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_thinking_delta", runId: "run-1", delta: "line 1\nline 2" } as RuntimeAction,
    );
    const state3 = runtimeReducer(
      state2,
      { type: "stream_thinking_end", runId: "run-1", content: "line 1\nline 2\nline 3" } as RuntimeAction,
    );

    expect(state3.thinkingTraces["run-1"]?.hasModelThinking).toBe(true);
    expect(state3.thinkingTraces["run-1"]?.source).toBe("model");
    expect(state3.thinkingTraces["run-1"]?.lines).toEqual(["line 1", "line 2", "line 3"]);
  });

  test("stream_status fallback does not overwrite model thinking", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_thinking_start", runId: "run-1" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_thinking_delta", runId: "run-1", delta: "model line" } as RuntimeAction,
    );
    const state3 = runtimeReducer(
      state2,
      { type: "stream_status", runId: "run-1", text: "→ delegate → math" } as RuntimeAction,
    );

    expect(state3.thinkingTraces["run-1"]?.lines).toEqual(["model line"]);
    expect(state3.thinkingTraces["run-1"]?.source).toBe("model");
  });

  test("stream_error marks the run block as error", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_status", runId: "run-1", text: "→ tool_a" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_error", runId: "run-1", error: "boom" } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.status).toBe("error");
    expect(state2.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(true);
  });
});
