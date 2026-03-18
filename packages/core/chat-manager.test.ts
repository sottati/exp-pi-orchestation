import { expect, test } from "bun:test";
import type { AgentChat } from "./contracts";
import { ChatManager } from "./chat-manager";

async function waitUntil(predicate: () => boolean, timeoutMs = 800): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("timeout waiting for condition");
}

function baseInput(overrides: Partial<{
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: string;
    task: string;
    maxRetries: number;
}> = {}) {
    return {
        sessionId: overrides.sessionId ?? "s1",
        parentRunId: overrides.parentRunId ?? "run_1",
        parentTurnId: overrides.parentTurnId ?? "turn_1",
        agentId: overrides.agentId ?? "code",
        task: overrides.task ?? "do thing",
        maxRetries: overrides.maxRetries,
    };
}

function sampleRecord(overrides: Partial<AgentChat>): AgentChat {
    return {
        chatId: overrides.chatId ?? "chat_1",
        sessionId: overrides.sessionId ?? "s1",
        parentRunId: overrides.parentRunId ?? "run_1",
        parentTurnId: overrides.parentTurnId ?? "turn_1",
        agentId: overrides.agentId ?? "code",
        task: overrides.task ?? "t",
        context: overrides.context,
        status: overrides.status ?? "waiting",
        closeReason: overrides.closeReason,
        createdAt: overrides.createdAt ?? 1,
        updatedAt: overrides.updatedAt ?? 1,
        startedAt: overrides.startedAt,
        closedAt: overrides.closedAt,
        attempts: overrides.attempts ?? 0,
        maxRetries: overrides.maxRetries ?? 1,
        timeoutMs: overrides.timeoutMs ?? 20_000,
        result: overrides.result,
        error: overrides.error,
    };
}

test("ChatManager retries then completes", async () => {
    let attempts = 0;
    const manager = new ChatManager();

    const chat = manager.createChat(baseInput({ maxRetries: 1 }), async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first fail");
        return "ok";
    });

    await waitUntil(() => manager.getChat(chat.chatId)?.status === "closed");
    const final = manager.getChat(chat.chatId);
    expect(final).toBeDefined();
    expect(final?.closeReason).toBe("completed");
    expect(final?.attempts).toBe(2);
});

test("ChatManager enforces FIFO per-agent queue", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
    });

    const manager = new ChatManager({ getMaxConcurrency: () => 1 });

    const first = manager.createChat(baseInput({ task: "first" }), async () => {
        order.push("start:first");
        const output = await firstDone;
        order.push("end:first");
        return output;
    });
    const second = manager.createChat(baseInput({ task: "second" }), async () => {
        order.push("start:second");
        return "second";
    });

    expect(manager.getChat(first.chatId)?.status).toBe("active");
    expect(manager.getChat(second.chatId)?.status).toBe("waiting");

    releaseFirst();

    await waitUntil(() => manager.getChat(second.chatId)?.status === "closed");
    expect(order).toEqual(["start:first", "end:first", "start:second"]);
    expect(manager.getChat(second.chatId)?.closeReason).toBe("completed");
});

test("closeChat is idempotent for active chat", async () => {
    let cancelHooks = 0;
    const manager = new ChatManager({
        hooks: {
            onCancelled: () => {
                cancelHooks += 1;
            },
        },
    });

    const chat = manager.createChat(baseInput(), async ({ signal }) => {
        return await new Promise<string>((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error("aborted"));
                return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(() => resolve("late"), 5000);
        });
    });

    await waitUntil(() => manager.getChat(chat.chatId)?.status === "active");
    manager.closeChat(chat.chatId);
    manager.closeChat(chat.chatId);

    await waitUntil(() => manager.getChat(chat.chatId)?.status === "closed");
    await Bun.sleep(20);

    const final = manager.getChat(chat.chatId);
    expect(final?.closeReason).toBe("cancelled");
    expect(cancelHooks).toBe(1);
});

test("restore closes interrupted chats", async () => {
    const persisted: AgentChat[] = [];
    const manager = new ChatManager({
        restoreRecords: async () => [
            sampleRecord({ chatId: "active-chat", status: "active" }),
            sampleRecord({ chatId: "waiting-chat", status: "waiting" }),
            sampleRecord({ chatId: "closed-chat", status: "closed", closeReason: "completed" }),
        ],
        persistChat: async (chat) => {
            persisted.push({ ...chat });
        },
    });

    const recovered = await manager.restore();
    expect(recovered).toBe(2);

    const active = manager.getChat("active-chat");
    const waiting = manager.getChat("waiting-chat");
    const closed = manager.getChat("closed-chat");

    expect(active?.status).toBe("closed");
    expect(active?.closeReason).toBe("failed");
    expect(active?.error).toBe("Interrupted by runtime restart");

    expect(waiting?.status).toBe("closed");
    expect(waiting?.closeReason).toBe("failed");
    expect(waiting?.error).toBe("Interrupted by runtime restart");

    expect(closed?.status).toBe("closed");
    expect(closed?.closeReason).toBe("completed");

    expect(persisted.length).toBe(2);
});

test("pauseTimeout prevents chat timeout during HITL", async () => {
  const manager = new ChatManager();
  let hitlResolved = false;

  const chat = manager.createChat(
    { ...baseInput({ task: "hitl-test" }), timeoutMs: 50 },
    async (_ctx, chatRecord) => {
      manager.pauseTimeout(chatRecord.chatId);
      await Bun.sleep(150);
      manager.resumeTimeout(chatRecord.chatId);
      hitlResolved = true;
      return "done";
    }
  );

  await waitUntil(() => manager.getChat(chat.chatId)?.status === "closed");
  expect(hitlResolved).toBe(true);
  expect(manager.getChat(chat.chatId)?.closeReason).toBe("completed");
});
