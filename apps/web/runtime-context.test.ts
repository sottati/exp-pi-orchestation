import { describe, expect, test } from "bun:test";
import { buildOutgoingChatPayload, initialRuntimeState, runtimeReducer, type RuntimeAction, type RuntimeState } from "./runtime-context";

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
  test("chat_sending starts streaming without inventing a thinking block", () => {
    const state = runtimeReducer(
      freshState(),
      { type: "chat_sending", runId: "run-1", toAgentId: "orchestrator" } as RuntimeAction,
    );

    expect(state.isStreaming).toBe(true);
    expect(state.currentRunId).toBe("run-1");
    expect(state.thinkingTraces["run-1"]).toBeUndefined();
    expect(state.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(false);
  });

  test("thinking stream events create and append model lines in real time", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_thinking_start", runId: "run-1" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_thinking_delta", runId: "run-1", delta: "line 1\nline 2" } as RuntimeAction,
    );
    const state3 = runtimeReducer(
      state1,
      { type: "stream_thinking_end", runId: "run-1", content: "line 1\nline 2\nline 3" } as RuntimeAction,
    );

    expect(state3.thinkingTraces["run-1"]).toMatchObject({
      status: "completed",
      collapsed: true,
      lines: ["line 1", "line 2", "line 3"],
      source: "model",
      hasModelThinking: true,
    });
    expect(state3.chatItems.filter((item) => item.kind === "thinking_trace")).toHaveLength(1);
  });

  test("stream_end closes the run block without removing it", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_thinking_delta", runId: "run-1", delta: "line 1" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_end", runId: "run-1", answer: "ok", durationMs: 10 } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.status).toBe("completed");
    expect(state2.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(true);
  });

  test("no thinking block is rendered when only final text arrives", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "chat_sending", runId: "run-1", toAgentId: "orchestrator" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_end", runId: "run-1", answer: "ok", durationMs: 10 } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]).toBeUndefined();
    expect(state2.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(false);
  });

  test("stream_error marks the run block as error", () => {
    const state1 = runtimeReducer(
      freshState(),
      { type: "stream_thinking_delta", runId: "run-1", delta: "line 1" } as RuntimeAction,
    );
    const state2 = runtimeReducer(
      state1,
      { type: "stream_error", runId: "run-1", error: "boom" } as RuntimeAction,
    );

    expect(state2.thinkingTraces["run-1"]?.status).toBe("error");
    expect(state2.chatItems.some((item) => item.kind === "thinking_trace" && item.runId === "run-1")).toBe(true);
  });

  test("agents event does not clobber hydrated org context", () => {
    const hydrated = runtimeReducer(
      freshState(),
      {
        type: "hydrate",
        snapshot: {
          ...initialRuntimeState,
          agents: [],
          sessionId: "s1",
          orgId: "org-a",
          messages: [],
          chatItems: [],
          traces: [],
          delegations: {},
          thinkingTraces: {},
          traceDurations: {},
          chats: [],
          jobs: [],
        },
      } as RuntimeAction,
    );
    const state = runtimeReducer(
      hydrated,
      { type: "agents", agents: [], sessionId: "s1", orgId: "default" } as RuntimeAction,
    );

    expect(state.orgId).toBe("org-a");
  });
});

describe("buildOutgoingChatPayload", () => {
  test("includes active thread context in outgoing UI chat messages", () => {
    expect(buildOutgoingChatPayload({
      orgId: "org-a",
      selectedOrchestratorId: "orchestrator:sales",
      selectedContact: "+5491112345678",
    }, "hola")).toEqual({
      type: "chat",
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      contact: "+5491112345678",
      content: "hola",
    });
  });
});
