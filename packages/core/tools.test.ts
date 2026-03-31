import { describe, expect, test } from "bun:test";
import { createOrchestratorTools } from "./tools";
import type { AgentChat, RunContext } from "./contracts";

function makeRunContext(): RunContext {
  return {
    runId: "run_1",
    turnId: "turn_1",
    sessionId: "session_1",
  };
}

function makeChat(agentId: string, task: string): AgentChat {
  const now = Date.now();
  return {
    chatId: "chat_1",
    sessionId: "session_1",
    parentRunId: "run_1",
    parentTurnId: "turn_1",
    agentId,
    task,
    status: "active",
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    maxRetries: 1,
    timeoutMs: 300_000,
  };
}

describe("orchestrator delegate task validation", () => {
  test("accepts numbered task text with ')' and normalizes whitespace", async () => {
    let delegatedTask = "";
    const tools = createOrchestratorTools({
      registry: {
        marketing: {
          id: "marketing",
          name: "Marketing",
          role: "Marketing specialist",
          capabilities: ["seo"],
          maxConcurrency: 1,
          createAgent: () => ({} as any),
        },
      },
      getRunContext: () => makeRunContext(),
      getOrchestratorAgentId: () => "orchestrator:main",
      createDelegation: (input) => {
        delegatedTask = input.task;
        return makeChat(input.agentId, input.task);
      },
      getChat: () => undefined,
      closeChat: () => undefined,
      getQueuePosition: () => undefined,
      traceToolEvent: async () => {},
    });

    const delegate = tools.find((t) => t.name === "delegate");
    if (!delegate) throw new Error("delegate tool not found");

    await delegate.execute("call_1", {
      agentId: "marketing",
      task: "  Analizá el negocio: 1) mercado  2) costos  ",
    });

    expect(delegatedTask).toBe("Analizá el negocio: 1) mercado 2) costos");
  });

  test("rejects empty task", async () => {
    const tools = createOrchestratorTools({
      registry: {
        marketing: {
          id: "marketing",
          name: "Marketing",
          role: "Marketing specialist",
          capabilities: ["seo"],
          maxConcurrency: 1,
          createAgent: () => ({} as any),
        },
      },
      getRunContext: () => makeRunContext(),
      getOrchestratorAgentId: () => "orchestrator:main",
      createDelegation: (input) => makeChat(input.agentId, input.task),
      getChat: () => undefined,
      closeChat: () => undefined,
      getQueuePosition: () => undefined,
      traceToolEvent: async () => {},
    });

    const delegate = tools.find((t) => t.name === "delegate");
    if (!delegate) throw new Error("delegate tool not found");

    await expect(delegate.execute("call_2", { agentId: "marketing", task: "   " }))
      .rejects.toThrow("Task cannot be empty.");
  });

  test("rejects tasks longer than max length", async () => {
    const tools = createOrchestratorTools({
      registry: {
        marketing: {
          id: "marketing",
          name: "Marketing",
          role: "Marketing specialist",
          capabilities: ["seo"],
          maxConcurrency: 1,
          createAgent: () => ({} as any),
        },
      },
      getRunContext: () => makeRunContext(),
      getOrchestratorAgentId: () => "orchestrator:main",
      createDelegation: (input) => makeChat(input.agentId, input.task),
      getChat: () => undefined,
      closeChat: () => undefined,
      getQueuePosition: () => undefined,
      traceToolEvent: async () => {},
    });

    const delegate = tools.find((t) => t.name === "delegate");
    if (!delegate) throw new Error("delegate tool not found");

    await expect(delegate.execute("call_3", { agentId: "marketing", task: "a".repeat(10_001) }))
      .rejects.toThrow("Task exceeds maximum length of 10000 characters.");
  });
});
