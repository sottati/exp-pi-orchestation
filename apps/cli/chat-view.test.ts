import { expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { BaseAgentId, ThreadEnvelope } from "../../packages/core/contracts";
import type { ChatInspection } from "../../packages/core/runtime";
import { chatSummary, collectChatDelta } from "./chat-view";

function buildEnvelope(input: {
    envelopeId: string;
    chatId: string;
    runId: string;
    turnId: string;
    timestamp: number;
    fromAgentId: BaseAgentId;
    toAgentId: BaseAgentId;
    content: string;
}): ThreadEnvelope {
    return {
        envelopeId: input.envelopeId,
        sessionId: "session-test",
        threadId: "session-test::code<->orchestrator",
        runId: input.runId,
        turnId: input.turnId,
        timestamp: input.timestamp,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        initiator: "orchestrator",
        chatId: input.chatId,
        message: {
            role: input.fromAgentId === "code" ? "assistant" : "user",
            content: input.content,
            timestamp: input.timestamp,
        } as unknown as AgentMessage,
    };
}

function buildInspection(envelopes: ThreadEnvelope[]): ChatInspection {
    return {
        queryId: "chat-1",
        traceEvents: [],
        threadIds: ["session-test::code<->orchestrator"],
        threadMessages: envelopes,
        summary: { status: "running", agentId: "code" },
    };
}

test("collectChatDelta prints turn headers and readable lines", () => {
    const details = buildInspection([
        buildEnvelope({
            envelopeId: "e1",
            chatId: "chat-1",
            runId: "run-1",
            turnId: "turn-1",
            timestamp: 1,
            fromAgentId: "orchestrator",
            toAgentId: "code",
            content: "plan this task",
        }),
        buildEnvelope({
            envelopeId: "e2",
            chatId: "chat-1",
            runId: "run-1",
            turnId: "turn-1",
            timestamp: 2,
            fromAgentId: "code",
            toAgentId: "orchestrator",
            content: "done",
        }),
        buildEnvelope({
            envelopeId: "e3",
            chatId: "chat-1",
            runId: "run-1",
            turnId: "turn-2",
            timestamp: 3,
            fromAgentId: "orchestrator",
            toAgentId: "code",
            content: "[chat_status:running] chatId=chat-1 waiting follow-up",
        }),
        buildEnvelope({
            envelopeId: "e4",
            chatId: "chat-other",
            runId: "run-1",
            turnId: "turn-3",
            timestamp: 4,
            fromAgentId: "orchestrator",
            toAgentId: "code",
            content: "ignore me",
        }),
    ]);

    const printedEnvelopes = new Set<string>();
    const printedTurns = new Set<string>();
    const firstPass = collectChatDelta(details, printedEnvelopes, printedTurns);
    expect(firstPass).toEqual([
        "[chat] chat-1 turn run=run-1 turn=turn-1",
        "[chat] chat-1 orchestrator -> code: plan this task",
        "[chat] chat-1 code -> orchestrator: done",
        "[chat] chat-1 turn run=run-1 turn=turn-2",
        "[chat] chat-1 running: waiting follow-up",
    ]);

    const secondPass = collectChatDelta(details, printedEnvelopes, printedTurns);
    expect(secondPass).toEqual([]);
});

test("chatSummary shows retries when chat record exists", () => {
    const details: ChatInspection = {
        queryId: "chat-2",
        traceEvents: [],
        threadIds: [],
        threadMessages: [],
        chat: {
            chatId: "chat-2",
            conversationId: "session-test::code<->orchestrator",
            sessionId: "session-test",
            parentRunId: "run-10",
            parentTurnId: "turn-10",
            agentId: "code",
            task: "demo",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            attempts: 2,
            maxRetries: 3,
            timeoutMs: 1000,
        },
    };

    expect(chatSummary(details)).toBe("chat=chat-2 agent=code status=active attempts=2/4");
});
