import { expect, test } from "bun:test";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
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

function createEventfulFakeAgent() {
    const state = { messages: [] as AgentMessage[] };
    const listeners = new Set<(event: AgentEvent) => void>();

    const agent = {
        state,
        replaceMessages(messages: AgentMessage[]) {
            state.messages = [...messages];
        },
        subscribe(listener: (event: AgentEvent) => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async prompt(message: AgentMessage | AgentMessage[]) {
            const prompted = Array.isArray(message) ? message : [message];
            state.messages.push(...prompted);
            for (const listener of listeners) {
                listener({ type: "response_chunk", role: "assistant", content: "chunk" } as unknown as AgentEvent);
            }
            state.messages.push({
                role: "assistant",
                content: "stub-answer",
                timestamp: Date.now(),
            } as unknown as AgentMessage);
        },
    } as unknown as Agent;

    return { agent };
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

test("runtime uses same routing pipeline for human and intra-agent inputs", async () => {
    const sessionId = `t04-pipeline-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);
    const fake = createEventfulFakeAgent();

    (runtime as unknown as {
        createAgentForRoute: (toAgentId: Exclude<BaseAgentId, "user">) => Agent;
    }).createAgentForRoute = () => fake.agent;

    const humanEvents: AgentEvent[] = [];
    const delegatedEvents: AgentEvent[] = [];

    await runtime.chat({
        fromAgentId: "user",
        toAgentId: "code",
        content: "human-turn",
        onAgentEvent: (event) => {
            humanEvents.push(event);
        },
    });

    await runtime.chat({
        fromAgentId: "orchestrator",
        toAgentId: "code",
        content: "delegated-turn",
        onAgentEvent: (event) => {
            delegatedEvents.push(event);
        },
    });

    expect(humanEvents.length).toBeGreaterThan(0);
    expect(delegatedEvents.length).toBeGreaterThan(0);

    const traces = await runtime.getTraces();
    const routed = traces.filter((trace) => trace.type === "message_routed");
    expect(routed).toHaveLength(2);

    const fromAgents = routed
        .map((trace) => trace.details?.fromAgentId)
        .filter((value): value is string => typeof value === "string")
        .sort();
    expect(fromAgents).toEqual(["orchestrator", "user"]);
});

test("runtime keeps run and turn correlation in persisted envelopes", async () => {
    const sessionId = `t04-correlation-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);
    const fake = createEventfulFakeAgent();

    (runtime as unknown as {
        createAgentForRoute: (toAgentId: Exclude<BaseAgentId, "user">) => Agent;
    }).createAgentForRoute = () => fake.agent;

    const human = await runtime.chat({
        fromAgentId: "user",
        toAgentId: "code",
        content: "human-turn",
    });
    const delegated = await runtime.chat({
        fromAgentId: "orchestrator",
        toAgentId: "code",
        content: "delegated-turn",
    });

    const humanThread = await runtime.getThread(createThreadId(sessionId, "user", "code"));
    const delegatedThread = await runtime.getThread(createThreadId(sessionId, "orchestrator", "code"));

    const humanTurn = humanThread.filter((env) => env.runId === human.runContext.runId && env.turnId === human.runContext.turnId);
    const delegatedTurn = delegatedThread.filter((env) =>
        env.runId === delegated.runContext.runId && env.turnId === delegated.runContext.turnId
    );

    expect(humanTurn).toHaveLength(2);
    expect(delegatedTurn).toHaveLength(2);
    expect(humanTurn.map((env) => env.initiator)).toEqual(["user", "user"]);
    expect(delegatedTurn.map((env) => env.initiator)).toEqual(["orchestrator", "orchestrator"]);
});
