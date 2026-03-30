import { describe, expect, test } from "bun:test";
import type { AgentChat, ScheduledJob, ThreadEnvelope, TraceEvent } from "../../packages/core/contracts";
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

    const chats: AgentChat[] = [
      {
        chatId: "chat-1",
        sessionId,
        parentRunId: "run-1",
        parentTurnId: "turn-1",
        agentId: "math",
        task: "resolver 2+2",
        status: "closed",
        closeReason: "completed",
        createdAt: 120,
        updatedAt: 220,
        attempts: 1,
        maxRetries: 1,
        timeoutMs: 30_000,
        result: "4",
      },
    ];

    const jobs: ScheduledJob[] = [
      {
        jobId: "job-1",
        sessionId,
        createdBy: "secretary",
        targetAgentId: "writer",
        task: "enviar resumen",
        schedule: { type: "delay", delayMs: 5_000 },
        status: "active",
        runCount: 0,
        createdAt: 130,
        updatedAt: 230,
        nextRunAt: 5_130,
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      threadMessages,
      traces,
      chats,
      jobs,
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
    expect(state.thinkingTraces["run-1"]).toBeUndefined();
    expect(state.chats).toEqual(chats);
    expect(state.jobs).toEqual(jobs);
  });

  test("does not invent thinking traces from tool activity during hydrate", () => {
    const sessionId = "demo";
    const threadId = getPrimaryThreadId(sessionId);
    const threadMessages: ThreadEnvelope[] = [
      {
        envelopeId: "env-user-1",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 90,
        fromAgentId: "user",
        toAgentId: "orchestrator",
        initiator: "user",
        message: { role: "user", content: "hola", timestamp: 90 },
      },
      {
        envelopeId: "env-user-2",
        sessionId,
        threadId,
        runId: "run-2",
        turnId: "turn-2",
        timestamp: 190,
        fromAgentId: "user",
        toAgentId: "orchestrator",
        initiator: "user",
        message: { role: "user", content: "segui", timestamp: 190 },
      },
    ];
    const traces: TraceEvent[] = [
      {
        eventId: "evt-1",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 100,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator",
        toolName: "list_agents",
      },
      {
        eventId: "evt-2",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 110,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator",
        toolName: "delegate",
        details: { args: { agentId: "math", task: "2+2" } },
      },
      {
        eventId: "evt-3",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 130,
        type: "run_failed",
        status: "error",
        agentId: "orchestrator",
        details: { error: "boom" },
      },
      {
        eventId: "evt-4",
        sessionId,
        runId: "run-2",
        turnId: "turn-2",
        timestamp: 200,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator",
        toolName: "get_chat_status",
        details: { args: { chatId: "chat-1" } },
      },
      {
        eventId: "evt-5",
        sessionId,
        runId: "run-2",
        turnId: "turn-2",
        timestamp: 220,
        type: "run_completed",
        status: "completed",
        agentId: "orchestrator",
        details: { durationMs: 20 },
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      threadMessages,
      traces,
      chats: [],
      jobs: [],
    });

    expect(state.messages).toHaveLength(2);
    expect(state.chatItems).toEqual([
      { kind: "message", message: state.messages[0]! },
      { kind: "message", message: state.messages[1]! },
    ]);
    expect(state.thinkingTraces["run-1"]).toBeUndefined();
    expect(state.thinkingTraces["run-2"]).toBeUndefined();
  });

  test("rebuilds model thinking from persisted assistant messages", () => {
    const sessionId = "demo";
    const threadId = getPrimaryThreadId(sessionId);
    const threadMessages: ThreadEnvelope[] = [
      {
        envelopeId: "env-user-1",
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
        envelopeId: "env-assistant-1",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 300,
        fromAgentId: "orchestrator",
        toAgentId: "user",
        initiator: "user",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "linea 1\nlinea 2" },
            { type: "text", text: "respuesta final" },
          ],
          timestamp: 300,
        } as any,
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
        details: { args: { agentId: "math", task: "2+2" } },
      },
      {
        eventId: "evt-2",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 320,
        type: "run_completed",
        status: "completed",
        agentId: "orchestrator",
        details: { durationMs: 200 },
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      threadMessages,
      traces,
      chats: [],
      jobs: [],
    });

    expect(state.chatItems).toEqual([
      { kind: "message", message: state.messages[0]! },
      { kind: "thinking_trace", runId: "run-1" },
      { kind: "message", message: state.messages[1]! },
    ]);
    expect(state.thinkingTraces["run-1"]).toMatchObject({
      runId: "run-1",
      lines: ["linea 1", "linea 2"],
      status: "completed",
      source: "model",
      hasModelThinking: true,
    });
  });

  test("ignores traces from other runs when hydrating a selected past thread", () => {
    const sessionId = "demo";
    const threadId = getPrimaryThreadId(sessionId, {
      orchestratorId: "orchestrator:sales",
      contact: "+54 9 11 1234-5678",
    });
    const threadMessages: ThreadEnvelope[] = [
      {
        envelopeId: "env-user-1",
        sessionId,
        threadId,
        runId: "run-thread",
        turnId: "turn-1",
        timestamp: 100,
        fromAgentId: "external:+5491112345678",
        toAgentId: "orchestrator:sales",
        initiator: "external",
        message: { role: "user", content: "hola", timestamp: 100 },
      },
      {
        envelopeId: "env-assistant-1",
        sessionId,
        threadId,
        runId: "run-thread",
        turnId: "turn-1",
        timestamp: 200,
        fromAgentId: "orchestrator:sales",
        toAgentId: "external:+5491112345678",
        initiator: "external",
        message: { role: "assistant", content: [{ type: "text", text: "respuesta" }], timestamp: 200 } as any,
      },
    ];

    const traces: TraceEvent[] = [
      {
        eventId: "evt-thread-1",
        sessionId,
        runId: "run-thread",
        turnId: "turn-1",
        timestamp: 110,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator:sales",
        toolName: "delegate",
        toolCallId: "tool-thread",
        details: { args: { agentId: "math", task: "2+2" } },
      },
      {
        eventId: "evt-thread-2",
        sessionId,
        runId: "run-thread",
        turnId: "turn-1",
        timestamp: 210,
        type: "run_completed",
        status: "completed",
        agentId: "orchestrator:sales",
        details: { durationMs: 100 },
      },
      {
        eventId: "evt-other-1",
        sessionId,
        runId: "run-other",
        turnId: "turn-2",
        timestamp: 120,
        type: "tool_start",
        status: "running",
        agentId: "orchestrator:ops",
        toolName: "delegate",
        toolCallId: "tool-other",
        details: { args: { agentId: "writer", task: "foreign" } },
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      selectedOrchestratorId: "orchestrator:sales",
      selectedContact: "+5491112345678",
      threadMessages,
      traces,
      chats: [],
      jobs: [],
    });

    expect(Object.keys(state.delegations)).toEqual(["tool-thread"]);
    expect(state.thinkingTraces["run-thread"]).toBeUndefined();
    expect(state.thinkingTraces["run-other"]).toBeUndefined();
  });

  test("restores dynamic orchestrator thinking traces from persisted assistant messages", () => {
    const sessionId = "demo";
    const threadId = getPrimaryThreadId(sessionId, { orchestratorId: "orchestrator:sales", contact: "+5491112345678" });
    const threadMessages: ThreadEnvelope[] = [
      {
        envelopeId: "env-user-1",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 100,
        fromAgentId: "external:+5491112345678",
        toAgentId: "orchestrator:sales",
        initiator: "external",
        message: { role: "user", content: "hola", timestamp: 100 },
      },
      {
        envelopeId: "env-assistant-1",
        sessionId,
        threadId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 200,
        fromAgentId: "orchestrator:sales",
        toAgentId: "external:+5491112345678",
        initiator: "external",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "paso 1\npaso 2" },
            { type: "text", text: "ok" },
          ],
          timestamp: 200,
        } as any,
      },
    ];

    const traces: TraceEvent[] = [
      {
        eventId: "evt-1",
        sessionId,
        runId: "run-1",
        turnId: "turn-1",
        timestamp: 220,
        type: "run_completed",
        status: "completed",
        agentId: "orchestrator:sales",
        details: { durationMs: 120 },
      },
    ];

    const state = buildHydratedUiState({
      agents: [],
      sessionId,
      threadMessages,
      traces,
      chats: [],
      jobs: [],
    });

    expect(state.chatItems).toEqual([
      { kind: "message", message: state.messages[0]! },
      { kind: "thinking_trace", runId: "run-1" },
      { kind: "message", message: state.messages[1]! },
    ]);
    expect(state.thinkingTraces["run-1"]).toMatchObject({
      lines: ["paso 1", "paso 2"],
      status: "completed",
      source: "model",
    });
  });
});
