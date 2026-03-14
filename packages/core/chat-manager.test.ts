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
    keepAlive: boolean;
}> = {}) {
    return {
        sessionId: overrides.sessionId ?? "s1",
        parentRunId: overrides.parentRunId ?? "run_1",
        parentTurnId: overrides.parentTurnId ?? "turn_1",
        agentId: overrides.agentId ?? "code",
        task: overrides.task ?? "do thing",
        maxRetries: overrides.maxRetries,
        keepAlive: overrides.keepAlive,
    };
}

function sampleRecord(overrides: Partial<AgentChat>): AgentChat {
    return {
        chatId: overrides.chatId ?? "chat_1",
        conversationId: overrides.conversationId ?? "s1::code<->orchestrator",
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

test("ChatManager reuses stable conversation identity within session/agent pair", async () => {
    const manager = new ChatManager();

    const first = manager.createChat(baseInput({ sessionId: "s1", agentId: "code", task: "one" }), async () => "ok-1");
    const second = manager.createChat(baseInput({ sessionId: "s1", agentId: "code", task: "two" }), async () => "ok-2");

    expect(first.chatId).not.toBe(second.chatId);
    expect(first.conversationId).toBe(second.conversationId);
});

test("ChatManager does not collide conversation identity across sessions", async () => {
    const manager = new ChatManager();

    const first = manager.createChat(baseInput({ sessionId: "s1", agentId: "code" }), async () => "ok");
    const second = manager.createChat(baseInput({ sessionId: "s2", agentId: "code" }), async () => "ok");

    expect(first.conversationId).not.toBe(second.conversationId);
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

test("keepAlive chat handles 3+ turns without auto-close", async () => {
    const seenTasks: string[] = [];
    const manager = new ChatManager();

    const chat = manager.createChat(baseInput({ task: "turn-1", keepAlive: true }), async (_ctx, current) => {
        seenTasks.push(current.task);
        return `ack:${current.task}`;
    });

    await waitUntil(() => manager.getChat(chat.chatId)?.result === "ack:turn-1");
    expect(manager.getChat(chat.chatId)?.status).toBe("active");

    await manager.sendMessage(chat.chatId, { task: "turn-2" });
    await manager.sendMessage(chat.chatId, { task: "turn-3" });

    await waitUntil(() => manager.getChat(chat.chatId)?.result === "ack:turn-3");

    const latest = manager.getChat(chat.chatId);
    expect(seenTasks).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(latest?.status).toBe("active");
    expect(latest?.closeReason).toBeUndefined();
    expect(latest?.result).toBe("ack:turn-3");
});

test("keepAlive chat processes queued follow-ups in order", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
    });

    const seenTasks: string[] = [];
    const manager = new ChatManager();

    const chat = manager.createChat(baseInput({ task: "turn-1", keepAlive: true }), async (_ctx, current) => {
        seenTasks.push(current.task);
        if (current.task === "turn-1") {
            await firstGate;
        }
        return `ack:${current.task}`;
    });

    await waitUntil(() => seenTasks.length === 1);

    const p2 = manager.sendMessage(chat.chatId, { task: "turn-2" });
    const p3 = manager.sendMessage(chat.chatId, { task: "turn-3" });
    releaseFirst();

    await p2;
    await p3;
    await waitUntil(() => manager.getChat(chat.chatId)?.result === "ack:turn-3");

    expect(seenTasks).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(manager.getChat(chat.chatId)?.status).toBe("active");
});
