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

    const calls: Array<{ agentId: string; task: string; context?: string }> = [];

    const deps: OrchestratorToolDeps = {
        registry,
        getRunContext: () => ({ runId: "run_1", turnId: "turn_1", sessionId: "s1" }),
        createDelegation: (input) => {
            calls.push({ agentId: input.agentId, task: input.task, context: input.context });
            return {
                chatId: "chat_1",
                conversationId: "s1::code<->orchestrator",
                sessionId: "s1",
                parentRunId: input.runContext.runId,
                parentTurnId: input.runContext.turnId,
                agentId: input.agentId,
                task: input.task,
                context: input.context,
                status: "active",
                createdAt: 1,
                updatedAt: 1,
                attempts: 0,
                maxRetries: 1,
                timeoutMs: 20_000,
            };
        },
        getChat: () => undefined,
        closeChat: () => undefined,
        getQueuePosition: () => undefined,
        traceToolEvent: async () => undefined,
    };

    return { deps, calls };
}

test("delegate_task alias matches delegate behavior", async () => {
    const { deps, calls } = buildDeps();
    const tools = createOrchestratorTools(deps);
    const delegate = tools.find((tool) => tool.name === "delegate");
    const alias = tools.find((tool) => tool.name === "delegate_task");

    expect(delegate).toBeDefined();
    expect(alias).toBeDefined();

    const params = { agentId: "code", task: "  add tests  ", context: "ctx" };
    const delegateResult = await delegate!.execute("call_1", params as never);
    const aliasResult = await alias!.execute("call_2", params as never);

    expect(calls).toEqual([
        { agentId: "code", task: "add tests", context: "ctx" },
        { agentId: "code", task: "add tests", context: "ctx" },
    ]);
    expect(delegateResult.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        status: "active",
        agentId: "code",
    });
    expect(aliasResult.details).toMatchObject({
        chatId: "chat_1",
        conversationId: "s1::code<->orchestrator",
        status: "active",
        agentId: "code",
    });
    expect(aliasResult.content).toEqual(delegateResult.content);
});
