import { expect, test } from "bun:test";
import { createOrchestratorTools, type OrchestratorToolDeps, type SpecialistRegistry } from "./tools";

function buildDeps() {
    const registry: SpecialistRegistry = {
        code: {
            id: "code",
            name: "Code",
            role: "Writes code",
            capabilities: ["coding"],
            maxConcurrency: 1,
            createAgent: () => ({}) as any,
        },
    };

    const delegatedCalls: Array<{ agentId: string; task: string; context?: string }> = [];
    const followUps: Array<{ chatId: string; task: string; context?: string }> = [];

    let activeChat: {
        chatId: string;
        conversationId: string;
        status: "active" | "waiting" | "closed";
        closeReason?: "completed" | "failed" | "cancelled";
        result?: string;
        error?: string;
        keepAlive: boolean;
    } | undefined;

    const deps: OrchestratorToolDeps = {
        registry,
        getRunContext: () => ({ runId: "run_1", turnId: "turn_1", sessionId: "s1" }),
        createDelegation: (input) => {
            delegatedCalls.push({ agentId: input.agentId, task: input.task, context: input.context });
            activeChat = {
                chatId: "chat_1",
                conversationId: "s1::code<->orchestrator",
                status: "active",
                result: `ack:${input.task}`,
                keepAlive: true,
            };
            return {
                chatId: activeChat.chatId,
                conversationId: activeChat.conversationId,
                sessionId: "s1",
                parentRunId: input.runContext.runId,
                parentTurnId: input.runContext.turnId,
                agentId: input.agentId,
                task: input.task,
                context: input.context,
                status: activeChat.status,
                createdAt: 1,
                updatedAt: 1,
                attempts: 0,
                maxRetries: 1,
                timeoutMs: 20_000,
                keepAlive: true,
                result: activeChat.result,
            };
        },
        findContinuableChat: ({ sessionId, agentId }) => {
            if (!activeChat || activeChat.status !== "active") return undefined;
            if (sessionId !== "s1" || agentId !== "code") return undefined;
            return {
                chatId: activeChat.chatId,
                conversationId: activeChat.conversationId,
                sessionId,
                parentRunId: "run_1",
                parentTurnId: "turn_1",
                agentId,
                task: "current",
                status: activeChat.status,
                createdAt: 1,
                updatedAt: 1,
                attempts: 1,
                maxRetries: 1,
                timeoutMs: 20_000,
                keepAlive: activeChat.keepAlive,
                result: activeChat.result,
            };
        },
        sendChatFollowUp: async (chatId, input) => {
            followUps.push({ chatId, task: input.task, context: input.context });
            if (!activeChat || activeChat.chatId !== chatId) {
                throw new Error(`chatId ${chatId} not found.`);
            }
            activeChat.result = `ack:${input.task}`;
            return {
                chatId: activeChat.chatId,
                conversationId: activeChat.conversationId,
                sessionId: "s1",
                parentRunId: "run_1",
                parentTurnId: "turn_1",
                agentId: "code",
                task: input.task,
                context: input.context,
                status: "active",
                createdAt: 1,
                updatedAt: 2,
                attempts: 1,
                maxRetries: 1,
                timeoutMs: 20_000,
                keepAlive: true,
                result: activeChat.result,
            };
        },
        getChat: (chatId) => {
            if (!activeChat || activeChat.chatId !== chatId) return undefined;
            return {
                chatId: activeChat.chatId,
                conversationId: activeChat.conversationId,
                sessionId: "s1",
                parentRunId: "run_1",
                parentTurnId: "turn_1",
                agentId: "code",
                task: "latest",
                status: activeChat.status,
                closeReason: activeChat.closeReason,
                createdAt: 1,
                updatedAt: 2,
                attempts: 1,
                maxRetries: 1,
                timeoutMs: 20_000,
                keepAlive: activeChat.keepAlive,
                result: activeChat.result,
                error: activeChat.error,
            };
        },
        closeChat: () => undefined,
        getQueuePosition: () => undefined,
        traceToolEvent: async () => undefined,
    };

    return { deps, delegatedCalls, followUps };
}

test("delegate_task alias matches delegate behavior", async () => {
    const { deps, delegatedCalls, followUps } = buildDeps();
    const tools = createOrchestratorTools(deps);
    const delegate = tools.find((tool) => tool.name === "delegate");
    const alias = tools.find((tool) => tool.name === "delegate_task");

    expect(delegate).toBeDefined();
    expect(alias).toBeDefined();

    const params = { agentId: "code", task: "  add tests  ", context: "ctx" };
    const delegateResult = await delegate!.execute("call_1", params as never);
    const aliasResult = await alias!.execute("call_2", params as never);

    expect(delegatedCalls).toEqual([
        { agentId: "code", task: "add tests", context: "ctx" },
    ]);
    expect(followUps).toEqual([
        { chatId: "chat_1", task: "add tests", context: "ctx" },
    ]);
    expect(delegateResult.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        status: "active",
        agentId: "code",
        continued: false,
    });
    expect(aliasResult.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        status: "active",
        agentId: "code",
        continued: true,
    });
});

test("delegate + follow_up_chat + get_chat_result keeps same chat conversation", async () => {
    const { deps, delegatedCalls, followUps } = buildDeps();
    const tools = createOrchestratorTools(deps);

    const delegate = tools.find((tool) => tool.name === "delegate");
    const followUp = tools.find((tool) => tool.name === "follow_up_chat");
    const getResult = tools.find((tool) => tool.name === "get_chat_result");

    expect(delegate).toBeDefined();
    expect(followUp).toBeDefined();
    expect(getResult).toBeDefined();

    const first = await delegate!.execute("call_1", { agentId: "code", task: "first" } as never);
    const second = await followUp!.execute("call_2", { chatId: "chat_1", task: "second" } as never);
    const result = await getResult!.execute("call_3", { chatId: "chat_1" } as never);

    expect(delegatedCalls).toEqual([{ agentId: "code", task: "first", context: undefined }]);
    expect(followUps).toEqual([{ chatId: "chat_1", task: "second", context: undefined }]);

    expect(first.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        continued: false,
    });
    expect(second.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        status: "active",
    });
    expect(result.content).toEqual([{ type: "text", text: "ack:second" }]);
});
