import { test, expect, describe } from "bun:test";
import { createRestrictedDelegateTool } from "./delegation";
import type { AgentChat } from "./contracts";

function makeDeps() {
  const chats = new Map<string, AgentChat>();
  return {
    createDelegation: (input: { agentId: string; task: string }) => {
      const chat: AgentChat = {
        chatId: `chat_${Date.now()}`, sessionId: "s1",
        parentRunId: "r1", parentTurnId: "t1",
        agentId: input.agentId, task: input.task,
        status: "active" as const,
        createdAt: Date.now(), updatedAt: Date.now(),
        attempts: 0, maxRetries: 1, timeoutMs: 20000,
      };
      chats.set(chat.chatId, chat);
      return chat;
    },
    getChat: (id: string) => chats.get(id),
    closeChat: (id: string) => { const c = chats.get(id); if (c) c.status = "closed"; return c; },
    getQueuePosition: () => undefined,
    traceToolEvent: async () => {},
    getRunContext: () => ({ runId: "r1", turnId: "t1", sessionId: "s1" }),
  };
}

describe("createRestrictedDelegateTool", () => {
  test("delegates to allowed target", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "math", task: "compute 2+2" });
    expect(result.content[0].text).toContain("math");
    expect(result.content[0].text).toContain("chatId");
  });

  test("rejects target not in allowedTargets", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "search", task: "find stuff" });
    expect(result.content[0].text).toContain("not allowed");
  });

  test("rejects when maxDepth exceeded", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 2,
      currentDepth: 2,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    const result = await tool.execute("tc1", { agentId: "math", task: "compute" });
    expect(result.content[0].text).toContain("depth");
  });

  test("detects cycle in delegationChain", async () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "math",
      allowedTargets: ["code"],
      maxDepth: 5,
      currentDepth: 2,
      delegationChain: ["orchestrator", "code", "math"],
      deps: makeDeps(),
    });

    // "code" is already in the chain -> cycle
    const result = await tool.execute("tc1", { agentId: "code", task: "refactor" });
    expect(result.content[0].text).toContain("cycle");
  });

  test("tool name is 'delegate' (not delegate_task)", () => {
    const tool = createRestrictedDelegateTool({
      fromAgentId: "code",
      allowedTargets: ["math"],
      maxDepth: 3,
      currentDepth: 1,
      delegationChain: ["orchestrator", "code"],
      deps: makeDeps(),
    });

    expect(tool.name).toBe("delegate");
  });
});
