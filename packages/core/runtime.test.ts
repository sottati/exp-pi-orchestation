import { expect, test } from "bun:test";
import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { BaseAgentId, ThreadEnvelope } from "./contracts";
import { MultiAgentRuntime } from "./runtime";

function createThreadId(sessionId: string, a: BaseAgentId, b: BaseAgentId): string {
    return `${sessionId}::${[a, b].sort().join("<->")}`;
}

function createFakeAgent() {
    const state = { messages: [] as AgentMessage[] };
    let replacedMessages: AgentMessage[] = [];
    let promptedMessages: AgentMessage[] = [];

    const agent = {
        state,
        replaceMessages(messages: AgentMessage[]) {
            replacedMessages = [...messages];
            state.messages = [...messages];
        },
        subscribe() {
            return () => undefined;
        },
        async prompt(message: AgentMessage | AgentMessage[]) {
            promptedMessages = Array.isArray(message) ? [...message] : [message];
            state.messages.push(...promptedMessages);
            state.messages.push({
                role: "assistant",
                content: "stub-answer",
                timestamp: Date.now(),
            } as unknown as AgentMessage);
        },
    } as unknown as Agent;

    return {
        agent,
        getReplacedMessages: () => replacedMessages,
        getPromptedMessages: () => promptedMessages,
    };
}

function buildEnvelope(input: {
    sessionId: string;
    threadId: string;
    envelopeId: string;
    parentEnvelopeId?: string;
    role: "user" | "assistant";
    content: string;
}): ThreadEnvelope {
    return {
        envelopeId: input.envelopeId,
        parentEnvelopeId: input.parentEnvelopeId,
        replyToEnvelopeId: input.parentEnvelopeId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        runId: "seed-run",
        turnId: "seed-turn",
        timestamp: Date.now(),
        fromAgentId: input.role === "user" ? "user" : "code",
        toAgentId: input.role === "user" ? "code" : "user",
        initiator: input.role === "user" ? "user" : "specialist",
        message: {
            role: input.role,
            content: input.content,
            timestamp: Date.now(),
        } as unknown as AgentMessage,
    };
}

test("runtime applies configurable history window before prompt", async () => {
    const sessionId = `t03-window-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId, { historyWindowMessages: 2 });
    const fake = createFakeAgent();

    (runtime as unknown as {
        createAgentForRoute: (toAgentId: Exclude<BaseAgentId, "user">) => Agent;
    }).createAgentForRoute = () => fake.agent;

    const threadId = createThreadId(sessionId, "user", "code");
    const seeded: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
    ];

    let parentEnvelopeId: string | undefined;
    for (const [i, entry] of seeded.entries()) {
        const envelopeId = `seed-${i + 1}`;
        await runtime.store.appendThreadMessage(buildEnvelope({
            sessionId,
            threadId,
            envelopeId,
            parentEnvelopeId,
            role: entry.role,
            content: entry.content,
        }));
        parentEnvelopeId = envelopeId;
    }

    await runtime.chat({ toAgentId: "code", content: "current-turn" });

    const replaced = fake.getReplacedMessages();
    expect(replaced).toHaveLength(2);
    expect(replaced[0]).toMatchObject({ role: "user", content: "u2" });
    expect(replaced[1]).toMatchObject({ role: "assistant", content: "a2" });

    const prompted = fake.getPromptedMessages();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toMatchObject({ role: "user", content: "current-turn" });
});

test("runtime keeps full persisted thread while trimming model context", async () => {
    const sessionId = `t03-persist-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId, { historyWindowMessages: 1 });
    const fake = createFakeAgent();

    (runtime as unknown as {
        createAgentForRoute: (toAgentId: Exclude<BaseAgentId, "user">) => Agent;
    }).createAgentForRoute = () => fake.agent;

    const threadId = createThreadId(sessionId, "user", "code");
    await runtime.store.appendThreadMessage(buildEnvelope({
        sessionId,
        threadId,
        envelopeId: "seed-1",
        role: "user",
        content: "old-user",
    }));
    await runtime.store.appendThreadMessage(buildEnvelope({
        sessionId,
        threadId,
        envelopeId: "seed-2",
        parentEnvelopeId: "seed-1",
        role: "assistant",
        content: "old-assistant",
    }));

    await runtime.chat({ toAgentId: "code", content: "new-user" });

    const persisted = await runtime.getThread(threadId);
    expect(persisted).toHaveLength(4);
    expect(persisted[0]?.message).toMatchObject({ role: "user", content: "old-user" });
    expect(persisted[1]?.message).toMatchObject({ role: "assistant", content: "old-assistant" });
    expect(persisted[2]?.message).toMatchObject({ role: "user", content: "new-user" });
    expect(persisted[3]?.message).toMatchObject({ role: "assistant", content: "stub-answer" });

    const replaced = fake.getReplacedMessages();
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ role: "assistant", content: "old-assistant" });
});
