import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiAgentRuntime } from "./runtime";

function createScriptedAgent(
  nextAssistantMessage: () => AgentMessage,
  onReplaceMessages?: (messages: AgentMessage[]) => void,
) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const state = { messages: [] as AgentMessage[] };

  return {
    state,
    replaceMessages(messages: AgentMessage[]) {
      state.messages = [...messages];
      onReplaceMessages?.(state.messages);
    },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(message: AgentMessage) {
      state.messages.push(message);
      state.messages.push(nextAssistantMessage());
    },
  };
}

describe("MultiAgentRuntime routeMessage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "runtime-route-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("does not reuse stale assistant text from previous turns when current turn ends with provider error", async () => {
    const runtime = new MultiAgentRuntime({ sessionId: "test-route", dataDir });

    let turn = 0;
    (runtime as unknown as {
      createAgentForRoute: () => Promise<{
        agent: ReturnType<typeof createScriptedAgent>;
        selectedSkills: string[];
        availableSkills: number;
        skillErrors: string[];
      }>;
    }).createAgentForRoute = async () => ({
      agent: createScriptedAgent(() => {
        turn += 1;
        if (turn === 1) {
          return {
            role: "assistant",
            content: [{ type: "text", text: "Respuesta vieja que no debe reciclarse." }],
            stopReason: "stop",
            timestamp: Date.now(),
          } as any;
        }
        return {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "400 Provider returned error: invalid_request_error",
          timestamp: Date.now(),
        } as any;
      }),
      selectedSkills: [],
      availableSkills: 0,
      skillErrors: [],
    });

    const first = await runtime.chat({
      toAgentId: "code",
      content: "Primer turno",
    });
    expect(first.answer).toBe("Respuesta vieja que no debe reciclarse.");

    const second = await runtime.chat({
      toAgentId: "code",
      content: "Segundo turno",
    });
    expect(second.answer).toContain("Model error:");
    expect(second.answer).toContain("invalid_request_error");
    expect(second.answer).not.toContain("Respuesta vieja que no debe reciclarse.");
  });

  test("drops orphan toolResult from loaded history before prompting model", async () => {
    const runtime = new MultiAgentRuntime({ sessionId: "test-route-orphan", dataDir });
    const threadId = "test-route-orphan::code<->user";

    await runtime.store.appendThreadMessage({
      envelopeId: "env_orphan_1",
      sessionId: "test-route-orphan",
      threadId,
      runId: "run_old",
      turnId: "turn_old",
      timestamp: Date.now(),
      fromAgentId: "orchestrator:main",
      toAgentId: "code",
      initiator: "system",
      message: {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "get_chat_status",
        content: [{ type: "text", text: "chat active" }],
        timestamp: Date.now(),
      } as any,
    } as any);

    let loadedHistory: AgentMessage[] = [];
    (runtime as unknown as {
      createAgentForRoute: () => Promise<{
        agent: ReturnType<typeof createScriptedAgent>;
        selectedSkills: string[];
        availableSkills: number;
        skillErrors: string[];
      }>;
    }).createAgentForRoute = async () => ({
      agent: createScriptedAgent(
        () =>
          ({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            timestamp: Date.now(),
          }) as any,
        (messages) => {
          loadedHistory = [...messages];
        },
      ),
      selectedSkills: [],
      availableSkills: 0,
      skillErrors: [],
    });

    const out = await runtime.chat({
      toAgentId: "code",
      content: "Hola",
    });

    expect(out.answer).toBe("ok");
    expect(
      loadedHistory.some((message) => {
        const typed = message as { role?: unknown; toolCallId?: unknown };
        return typed.role === "toolResult" && typed.toolCallId === "call_orphan";
      }),
    ).toBe(false);
  });
});
