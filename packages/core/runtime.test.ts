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
    chatId?: string;
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
        chatId: input.chatId,
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

test("inspectChat returns consistent trace and thread audit for same chat", async () => {
    const sessionId = `t07-audit-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);
    const chatId = "chat-audit-1";
    const runId = "run-audit-1";
    const turnId = "turn-audit-1";
    const threadId = createThreadId(sessionId, "orchestrator", "code");

    await runtime.store.appendTrace({
        eventId: "trace-1",
        timestamp: Date.now(),
        sessionId,
        runId,
        turnId,
        type: "chat_created",
        status: "running",
        chatId,
        agentId: "code",
        details: { chatId },
    });
    await runtime.store.appendThreadMessage(buildEnvelope({
        sessionId,
        threadId,
        envelopeId: "env-1",
        chatId,
        role: "user",
        content: "start task",
    }));
    await runtime.store.appendThreadMessage(buildEnvelope({
        sessionId,
        threadId,
        envelopeId: "env-2",
        chatId,
        parentEnvelopeId: "env-1",
        role: "assistant",
        content: "task done",
    }));
    await runtime.store.appendTrace({
        eventId: "trace-2",
        timestamp: Date.now() + 1,
        sessionId,
        runId,
        turnId,
        type: "chat_completed",
        status: "completed",
        chatId,
        agentId: "code",
        details: { chatId },
    });

    const details = await runtime.inspectChat(chatId);

    expect(details.queryId).toBe(chatId);
    expect(details.summary).toMatchObject({ status: "completed", agentId: "code" });
    expect(details.traceEvents.map((event) => event.type)).toEqual(["chat_created", "chat_completed"]);
    expect(details.threadIds).toEqual([threadId]);
    expect(details.threadMessages.map((env) => String(env.message.content))).toEqual(["start task", "task done"]);
    expect(details.threadMessages.every((env) => env.chatId === chatId)).toBe(true);
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

test("runtime keeps concurrent conversation context isolated by thread identity", async () => {
    const sessionId = `t09-concurrent-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId, { historyWindowMessages: 3 });

    (runtime as unknown as {
        createAgentForRoute: (toAgentId: Exclude<BaseAgentId, "user">) => Agent;
    }).createAgentForRoute = () => {
        const state = { messages: [] as AgentMessage[] };
        return {
            state,
            replaceMessages(messages: AgentMessage[]) {
                state.messages = [...messages];
            },
            subscribe() {
                return () => undefined;
            },
            async prompt(message: AgentMessage | AgentMessage[]) {
                const prompted = Array.isArray(message) ? message : [message];
                state.messages.push(...prompted);
                const last = prompted.at(-1);
                state.messages.push({
                    role: "assistant",
                    content: `ack:${String(last?.content ?? "")}`,
                    timestamp: Date.now(),
                } as unknown as AgentMessage);
            },
        } as unknown as Agent;
    };

    const [human, delegated] = await Promise.all([
        runtime.chat({ fromAgentId: "user", toAgentId: "code", content: "human-concurrent" }),
        runtime.chat({ fromAgentId: "orchestrator", toAgentId: "code", content: "delegated-concurrent" }),
    ]);

    expect(human.answer).toBe("ack:human-concurrent");
    expect(delegated.answer).toBe("ack:delegated-concurrent");

    const humanThreadId = createThreadId(sessionId, "user", "code");
    const delegatedThreadId = createThreadId(sessionId, "orchestrator", "code");
    const humanThread = await runtime.getThread(humanThreadId);
    const delegatedThread = await runtime.getThread(delegatedThreadId);

    expect(humanThread.every((env) => env.threadId === humanThreadId)).toBe(true);
    expect(delegatedThread.every((env) => env.threadId === delegatedThreadId)).toBe(true);

    const humanContents = humanThread.map((env) => String(env.message.content));
    const delegatedContents = delegatedThread.map((env) => String(env.message.content));
    expect(humanContents).toContain("human-concurrent");
    expect(humanContents).toContain("ack:human-concurrent");
    expect(humanContents).not.toContain("delegated-concurrent");
    expect(delegatedContents).toContain("delegated-concurrent");
    expect(delegatedContents).toContain("ack:delegated-concurrent");
    expect(delegatedContents).not.toContain("human-concurrent");

    const humanTurn = humanThread.filter((env) => env.runId === human.runContext.runId && env.turnId === human.runContext.turnId);
    const delegatedTurn = delegatedThread.filter((env) =>
        env.runId === delegated.runContext.runId && env.turnId === delegated.runContext.turnId
    );
    expect(humanTurn).toHaveLength(2);
    expect(delegatedTurn).toHaveLength(2);
});

test("specialist does not emit outbound report without explicit report tool usage", async () => {
    const sessionId = `t06-reactive-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);

    (runtime as unknown as {
        createAgentForRoute: (
            toAgentId: Exclude<BaseAgentId, "user">,
            runContext: { runId: string; turnId: string; sessionId: string },
            enableOrchestratorTools?: boolean,
            chatId?: string,
        ) => Agent;
    }).createAgentForRoute = (toAgentId) => {
        const state = { messages: [] as AgentMessage[] };
        return {
            state,
            replaceMessages(messages: AgentMessage[]) {
                state.messages = [...messages];
            },
            subscribe() {
                return () => undefined;
            },
            async prompt(message: AgentMessage | AgentMessage[]) {
                const prompted = Array.isArray(message) ? message : [message];
                state.messages.push(...prompted);
                state.messages.push({
                    role: "assistant",
                    content: toAgentId === "math" ? "math-result" : "orchestrator-result",
                    timestamp: Date.now(),
                } as unknown as AgentMessage);
            },
        } as unknown as Agent;
    };

    const response = await runtime.chat({
        fromAgentId: "user",
        toAgentId: "math",
        content: "Compute 2 + 2. Do not report.",
    });

    expect(response.answer).toBe("math-result");

    const reportThread = await runtime.getThread(createThreadId(sessionId, "math", "orchestrator"));
    expect(reportThread).toHaveLength(0);
});

test("human -> math -> report_to_orchestrator completes via specialist tool", async () => {
    const sessionId = `t06-report-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);

    (runtime as unknown as {
        createAgentForRoute: (
            toAgentId: Exclude<BaseAgentId, "user">,
            runContext: { runId: string; turnId: string; sessionId: string },
            enableOrchestratorTools?: boolean,
            chatId?: string,
        ) => Agent;
    }).createAgentForRoute = (toAgentId) => {
        const state = { messages: [] as AgentMessage[] };
        return {
            state,
            replaceMessages(messages: AgentMessage[]) {
                state.messages = [...messages];
            },
            subscribe() {
                return () => undefined;
            },
            async prompt(message: AgentMessage | AgentMessage[]) {
                const prompted = Array.isArray(message) ? message : [message];
                state.messages.push(...prompted);
                state.messages.push({
                    role: "assistant",
                    content: toAgentId === "math" ? "math-result" : "report-received",
                    timestamp: Date.now(),
                } as unknown as AgentMessage);
            },
        } as unknown as Agent;
    };

    const first = await runtime.chat({
        fromAgentId: "user",
        toAgentId: "math",
        content: "Solve 8 + 9 and then report to orchestrator.",
    });
    expect(first.answer).toBe("math-result");

    const specialistTools = (runtime as unknown as {
        createSpecialistToolsForRun: (
            runContext: { runId: string; turnId: string; sessionId: string },
            specialistId: "math",
            chatId?: string,
        ) => Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<any> }>;
    }).createSpecialistToolsForRun(first.runContext, "math");

    const reportTool = specialistTools.find((tool) => tool.name === "report_to_orchestrator");
    expect(reportTool).toBeDefined();

    const report = await reportTool!.execute("call_report", { message: "sum is 17" });
    expect(report.details).toMatchObject({
        reportedBy: "math",
        reported: true,
        orchestratorReply: "report-received",
    });

    const reportThread = await runtime.getThread(createThreadId(sessionId, "math", "orchestrator"));
    const contents = reportThread.map((env) => String(env.message.content));
    expect(contents).toContain("Specialist report from math: sum is 17");
    expect(contents).toContain("report-received");
});

test("orchestrator run_bash executes command and persists tool traces", async () => {
    const sessionId = `t10-bash-${Date.now()}`;
    const runtime = new MultiAgentRuntime(sessionId);

    const runContext = { runId: "run_bash", turnId: "turn_bash", sessionId };
    const orchestratorTools = (runtime as unknown as {
        createOrchestratorToolsForRun: (
            runContext: { runId: string; turnId: string; sessionId: string },
        ) => Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<any> }>;
    }).createOrchestratorToolsForRun(runContext);

    const runBash = orchestratorTools.find((tool) => tool.name === "run_bash");
    expect(runBash).toBeDefined();

    const result = await runBash!.execute("call_run_bash", { command: "printf 'hello'" });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details).toMatchObject({
        exitCode: 0,
        timeoutMs: 20_000,
    });

    const traces = await runtime.getTraces();
    const bashTraces = traces.filter((trace) => trace.toolName === "run_bash");
    expect(bashTraces).toHaveLength(2);
    expect(bashTraces.map((trace) => trace.type)).toEqual(["tool_start", "tool_end"]);
    expect(bashTraces.map((trace) => trace.status)).toEqual(["running", "ok"]);
});
