import { describe, expect, test } from "bun:test";
import type { ThreadEnvelope, TraceEvent } from "../../packages/core/contracts";
import { buildHydratedUiState, getPrimaryThreadId } from "./ui-state";

describe("buildHydratedUiState", () => {
  test("restores messages, delegations, traces, durations", () => {
    const sessionId = "demo";
    const threadId = getPrimaryThreadId(sessionId);
    const threadMessages: ThreadEnvelope[] = [
      {
        envelopeId: "env-1",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 100,
        fromAgentId: "user",
        toAgentId: "orchestrator",
        initiator: "user",
        message: { role: "user", content: "hola", timestamp: 100 },
      },
      {
        envelopeId: "env-2",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 400,
        fromAgentId: "orchestrator",
        toAgentId: "user",
        initiator: "user",
        message: { role: "assistant", content: [{ type: "text", text: "respuesta" }], timestamp: 400 } as any,
      },
    ];

    const traces: TraceEvent[] = [
      {
        eventId: "evt-1",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 110,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator",
        toolName: "delegate",
        toolCallId: "tool-1",
        details: { args: { agentId: "math", task: "2+2" } },
      },
      {
        eventId: "evt-2",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 210,
        type: "tool_end",
        status: "ok",
        agentId: "orchestrator",
        toolName: "delegate",
        toolCallId: "tool-1",
        details: { result: "4" },
      },
      {
        eventId: "evt-3",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 410,
        type: "run_completed",
        status: "completed",
        agentId: "orchestrator",
        details: { durationMs: 300 },
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      threadMessages,
      traces,
    });
    const firstMessage = state.messages[0]!;
    const secondMessage = state.messages[1]!;

    expect(state.messages).toHaveLength(2);
    expect(secondMessage).toMatchObject({ role: "assistant", content: "respuesta", durationMs: 300 });
    expect(state.chatItems).toEqual([
      { kind: "message", message: firstMessage },
      { kind: "delegation", delegationId: "tool-1" },
      { kind: "message", message: secondMessage },
    ]);
    expect(state.delegations["tool-1"]).toMatchObject({
      toAgentId: "math",
      task: "2+2",
      result: "4",
      status: "ok",
      durationMs: 100,
    });
    expect(state.traceDurations["evt-2"]).toBe(100);
  });
});
