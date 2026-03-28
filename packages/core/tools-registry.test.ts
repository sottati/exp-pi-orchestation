import { test, expect, describe } from "bun:test";
import { createOrchestratorToolEntries } from "./tools";
import type { OrchestratorToolDeps } from "./tools";

function makeDeps(): OrchestratorToolDeps {
  return {
    registry: {},
    getRunContext: () => ({ runId: "r1", turnId: "t1", sessionId: "s1" }),
    getOrchestratorAgentId: () => "orchestrator",
    createDelegation: () => ({
      chatId: "c1", sessionId: "s1", parentRunId: "r1", parentTurnId: "t1",
      agentId: "code", task: "x", status: "active" as const,
      createdAt: 1, updatedAt: 1, attempts: 0, maxRetries: 1, timeoutMs: 20000,
    }),
    getChat: () => undefined,
    closeChat: () => undefined,
    getQueuePosition: () => undefined,
    traceToolEvent: async () => {},
  };
}

describe("createOrchestratorToolEntries", () => {
  test("returns ToolEntry array with correct names", () => {
    const entries = createOrchestratorToolEntries(makeDeps());
    const names = entries.map((e) => e.name);
    expect(names).toContain("list_agents");
    expect(names).toContain("delegate");
    expect(names).toContain("delegate_task");
    expect(names).toContain("get_chat_status");
    expect(names).toContain("get_chat_result");
    expect(names).toContain("close_chat");
  });

  test("entries have source=local and defaultPermission=allow", () => {
    const entries = createOrchestratorToolEntries(makeDeps());
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.defaultPermission).toBe("allow");
      expect(entry.available).toBe(true);
    }
  });
});
