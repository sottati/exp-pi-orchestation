import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import { createOrchestratorAgent, createSpecialistRegistry, ORCHESTRATOR_ID } from "./agents";
import type { BaseAgentId, Initiator, RunContext, TaskRecord, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { TaskManager } from "./task-manager";
import { ThreadStore } from "./thread-store";
import { createOrchestratorTools, type SpecialistRegistry } from "./tools";

interface RouteMessageInput {
    fromAgentId: BaseAgentId;
    toAgentId: Exclude<BaseAgentId, "user">;
    content: string;
    initiator: Initiator;
    runContext: RunContext;
    taskId?: string;
    toolCallId?: string;
}

interface RouteMessageOutput {
    answer: string;
    durationMs: number;
    threadId: string;
}

export interface TaskInspectionSummary {
    status: string;
    agentId?: string;
    createdAt?: number;
    updatedAt?: number;
}

export interface TaskInspection {
    queryId: string;
    job?: TaskRecord;
    summary?: TaskInspectionSummary;
    traceEvents: TraceEvent[];
    threadMessages: ThreadEnvelope[];
    threadIds: string[];
}

export interface ChatInput {
    toAgentId: Exclude<BaseAgentId, "user">;
    content: string;
    fromAgentId?: BaseAgentId;
}

export interface ChatOutput extends RouteMessageOutput {
    runContext: RunContext;
}

function extractLastAssistantText(messages: AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }

        return message.content
            .filter(
                (content): content is { type: "text"; text: string } =>
                    typeof content === "object" &&
                    content !== null &&
                    (content as { type?: string }).type === "text" &&
                    typeof (content as { text?: unknown }).text === "string",
            )
            .map((content) => content.text)
            .join("")
            .trim();
    }
    return "";
}

function resolveInitiator(fromAgentId: BaseAgentId): Initiator {
    if (fromAgentId === "user") return "user";
    if (fromAgentId === ORCHESTRATOR_ID) return "orchestrator";
    return "specialist";
}

function createThreadId(sessionId: string, a: BaseAgentId, b: BaseAgentId): string {
    return `${sessionId}::${[a, b].sort().join("<->")}`;
}

export class MultiAgentRuntime {
    readonly sessionId: string;
    readonly store: ThreadStore;
    readonly taskManager: TaskManager;
    readonly specialistRegistry: SpecialistRegistry;
    readonly orchestratorAgent: Agent;
    private readonly agentsById: Record<string, Agent>;
    private activeRunContext: RunContext;

    constructor(sessionId = "default") {
        this.sessionId = sessionId;
        this.store = new ThreadStore({ sessionId });
        this.specialistRegistry = createSpecialistRegistry();

        this.taskManager = new TaskManager({
            persistTask: (record) => this.store.appendTaskRecord(record),
            restoreRecords: () => this.store.getTaskRecords(),
            hooks: {
                onQueued: async (record) => {
                    await this.trace({
                        type: "task_queued",
                        status: "queued",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: { task: record.task },
                    });
                    await this.appendTaskStatusMessage(record, "queued", "Task queued for specialist execution.");
                },
                onStarted: async (record) => {
                    await this.trace({
                        type: "task_started",
                        status: "running",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: { attempts: record.attempts },
                    });
                    await this.appendTaskStatusMessage(
                        record,
                        "running",
                        `Task started (attempt ${record.attempts}/${record.maxRetries + 1}).`,
                    );
                },
                onRetry: async (record) => {
                    await this.trace({
                        type: "task_retry",
                        status: "running",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: { attempts: record.attempts, error: record.error },
                    });
                    await this.appendTaskStatusMessage(
                        record,
                        "running",
                        `Task retry scheduled after error: ${record.error ?? "unknown error"}`,
                    );
                },
                onCompleted: async (record) => {
                    await this.trace({
                        type: "task_completed",
                        status: "completed",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: {
                            attempts: record.attempts,
                            durationMs: (record.finishedAt ?? now()) - (record.startedAt ?? now()),
                        },
                    });
                    await this.appendTaskStatusMessage(record, "completed", "Task completed successfully.");
                },
                onFailed: async (record) => {
                    await this.trace({
                        type: "task_failed",
                        status: "error",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: { attempts: record.attempts, error: record.error },
                    });
                    await this.appendTaskStatusMessage(
                        record,
                        "failed",
                        `Task failed after ${record.attempts} attempts: ${record.error ?? "unknown error"}`,
                    );
                },
                onCancelled: async (record) => {
                    await this.trace({
                        type: "task_cancelled",
                        status: "cancelled",
                        runId: record.parentRunId,
                        turnId: record.parentTurnId,
                        taskId: record.jobId,
                        agentId: record.agentId,
                        details: { attempts: record.attempts },
                    });
                    await this.appendTaskStatusMessage(record, "cancelled", "Task cancelled.");
                },
            },
        });

        void this.taskManager.restore().then(n => {
            if (n > 0) console.error(`[runtime] restored ${n} interrupted task(s) as failed`);
        });

        this.activeRunContext = this.createRunContext();

        const tools = createOrchestratorTools({
            registry: this.specialistRegistry,
            getRunContext: () => this.activeRunContext,
            runSyncDelegation: async (input) => {
                const taskId = createId("task");
                const output = await this.routeMessage({
                    fromAgentId: ORCHESTRATOR_ID,
                    toAgentId: input.agentId,
                    content: input.context ? `Context:\n${input.context}\n\nTask:\n${input.task}` : input.task,
                    initiator: "orchestrator",
                    runContext: input.runContext,
                    taskId,
                    toolCallId: input.toolCallId,
                });
                return { ...output, taskId };
            },
            createAsyncDelegation: (input) => {
                return this.taskManager.createTask(
                    {
                        sessionId: this.sessionId,
                        parentRunId: input.runContext.runId,
                        parentTurnId: input.runContext.turnId,
                        agentId: input.agentId,
                        task: input.task,
                        context: input.context,
                        policy: { timeoutMs: input.timeoutMs, maxRetries: input.maxRetries },
                    },
                    async (_ctx, record) => {
                        const output = await this.routeMessage({
                            fromAgentId: ORCHESTRATOR_ID,
                            toAgentId: input.agentId,
                            content: input.context
                                ? `Context:\n${input.context}\n\nTask:\n${input.task}`
                                : input.task,
                            initiator: "orchestrator",
                            runContext: input.runContext,
                            taskId: record.jobId,
                        });
                        return output.answer;
                    },
                );
            },
            getTask: (jobId) => this.taskManager.getTask(jobId),
            cancelTask: (jobId) => this.taskManager.cancelTask(jobId),
            traceToolEvent: async (input) => {
                await this.trace({
                    type: input.type,
                    status: input.status,
                    runId: input.runContext.runId,
                    turnId: input.runContext.turnId,
                    toolName: input.toolName,
                    toolCallId: input.toolCallId,
                    details: input.details,
                });
            },
        });

        this.orchestratorAgent = createOrchestratorAgent(tools);
        const codeSpecialist = this.specialistRegistry.code;
        const mathSpecialist = this.specialistRegistry.math;
        if (!codeSpecialist || !mathSpecialist) {
            throw new Error("Specialists 'code' and 'math' are required in registry.");
        }
        this.agentsById = {
            [ORCHESTRATOR_ID]: this.orchestratorAgent,
            code: codeSpecialist.agent,
            math: mathSpecialist.agent,
        };
    }

    listAgents() {
        const specialists = Object.values(this.specialistRegistry).map((agent) => ({
            id: agent.id as BaseAgentId,
            name: agent.name,
            role: agent.role,
            capabilities: agent.capabilities,
        }));
        return [{ id: ORCHESTRATOR_ID, name: "Orchestrator", role: "Routes and delegates tasks.", capabilities: ["routing"] }, ...specialists];
    }

    listTasks(): TaskRecord[] {
        return this.taskManager.listTasks();
    }

    getTask(jobId: string): TaskRecord | undefined {
        return this.taskManager.getTask(jobId);
    }

    cancelTask(jobId: string): TaskRecord | undefined {
        return this.taskManager.cancelTask(jobId);
    }

    async listThreadIds(): Promise<string[]> {
        return this.store.listThreadIds();
    }

    async getThread(threadId: string): Promise<ThreadEnvelope[]> {
        return this.store.getThreadMessages(threadId);
    }

    async getTraces(): Promise<TraceEvent[]> {
        return this.store.getTraces();
    }

    async inspectTask(queryId: string): Promise<TaskInspection> {
        const job = this.getTask(queryId);
        const targetIds = new Set<string>([queryId]);
        if (job) {
            targetIds.add(job.jobId);
        }

        const allTraces = await this.store.getTraces();
        const traceEvents = allTraces.filter((event) => {
            if (event.taskId && targetIds.has(event.taskId)) {
                return true;
            }
            const detailTaskId = event.details?.taskId;
            return typeof detailTaskId === "string" && targetIds.has(detailTaskId);
        });

        for (const event of traceEvents) {
            if (event.taskId) {
                targetIds.add(event.taskId);
            }
            const detailTaskId = event.details?.taskId;
            if (typeof detailTaskId === "string") {
                targetIds.add(detailTaskId);
            }
        }

        const threadIds = await this.store.listThreadIds();
        const threadMessages: ThreadEnvelope[] = [];
        const relatedThreadIds = new Set<string>();
        for (const threadId of threadIds) {
            const messages = await this.store.getThreadMessages(threadId);
            const matched = messages.filter((message) => message.taskId && targetIds.has(message.taskId));
            if (matched.length > 0) {
                relatedThreadIds.add(threadId);
                threadMessages.push(...matched);
            }
        }

        // Synthesize summary from traces when no job record exists (sync tasks)
        let summary: TaskInspectionSummary | undefined;
        const first = traceEvents[0];
        const last = traceEvents[traceEvents.length - 1];
        if (!job && first && last) {
            summary = {
                status: last.status,
                agentId: last.agentId,
                createdAt: first.timestamp,
                updatedAt: last.timestamp,
            };
        }

        return {
            queryId,
            job,
            summary,
            traceEvents: traceEvents.sort((a, b) => a.timestamp - b.timestamp),
            threadMessages: threadMessages.sort((a, b) => a.timestamp - b.timestamp),
            threadIds: [...relatedThreadIds].sort(),
        };
    }

    async chat(input: ChatInput): Promise<ChatOutput> {
        const runContext = this.createRunContext();
        const fromAgentId = input.fromAgentId ?? "user";
        const initiator = resolveInitiator(fromAgentId);

        await this.trace({
            type: "run_started",
            status: "running",
            runId: runContext.runId,
            turnId: runContext.turnId,
            agentId: input.toAgentId,
            details: { fromAgentId, preview: input.content.slice(0, 120) },
        });

        try {
            const output = await this.withRunContext(runContext, async () =>
                this.routeMessage({
                    fromAgentId,
                    toAgentId: input.toAgentId,
                    content: input.content,
                    initiator,
                    runContext,
                }),
            );

            await this.trace({
                type: "run_completed",
                status: "completed",
                runId: runContext.runId,
                turnId: runContext.turnId,
                agentId: input.toAgentId,
                details: { durationMs: output.durationMs, threadId: output.threadId },
            });

            return {
                ...output,
                runContext,
            };
        } catch (error) {
            await this.trace({
                type: "run_failed",
                status: "error",
                runId: runContext.runId,
                turnId: runContext.turnId,
                agentId: input.toAgentId,
                details: { error: errorMessage(error) },
            });
            throw error;
        }
    }

    async runSmokeScenario(name: "math" | "code" | "orchestrator") {
        if (name === "math") {
            return this.chat({ toAgentId: "math", content: "Compute (8 * 5) - (6 / 2). Return one short sentence." });
        }
        if (name === "code") {
            return this.chat({
                toAgentId: "code",
                content: "Create a tiny Bun TypeScript function to sum two numbers and show one usage example.",
            });
        }
        return this.chat({
            toAgentId: ORCHESTRATOR_ID,
            content: [
                "Run a delegation demo.",
                "Call list_agents.",
                "Then solve (24 / 3) + (7 * 2) using delegate_task_sync and return one short sentence.",
            ].join(" "),
        });
    }

    private createRunContext(): RunContext {
        return {
            runId: createId("run"),
            turnId: createId("turn"),
            sessionId: this.sessionId,
        };
    }

    private async withRunContext<T>(runContext: RunContext, fn: () => Promise<T>): Promise<T> {
        const previous = this.activeRunContext;
        this.activeRunContext = runContext;
        try {
            return await fn();
        } finally {
            this.activeRunContext = previous;
        }
    }

    private async routeMessage(input: RouteMessageInput): Promise<RouteMessageOutput> {
        const startedAt = now();
        const agent = this.agentsById[input.toAgentId];
        if (!agent) {
            throw new Error(`Agent '${input.toAgentId}' is not registered.`);
        }

        const threadId = createThreadId(this.sessionId, input.fromAgentId, input.toAgentId);
        const history = await this.store.getThreadMessages(threadId);
        const historyMessages = history.map((item) => item.message);
        agent.replaceMessages(historyMessages);

        const userMessage: AgentMessage = {
            role: "user",
            content: input.content,
            timestamp: now(),
        };

        const beforeCount = historyMessages.length;
        await agent.prompt(userMessage);
        const newMessages = agent.state.messages.slice(beforeCount);
        let previousEnvelopeId = history.at(-1)?.envelopeId;
        let currentTurnUserEnvelopeId: string | undefined;

        for (const message of newMessages) {
            const envelopeId = createId("env");
            let replyToEnvelopeId = previousEnvelopeId;
            if (message.role === "assistant" && currentTurnUserEnvelopeId) {
                replyToEnvelopeId = currentTurnUserEnvelopeId;
            }

            const envelope: ThreadEnvelope = {
                envelopeId,
                parentEnvelopeId: previousEnvelopeId,
                replyToEnvelopeId,
                sessionId: this.sessionId,
                threadId,
                runId: input.runContext.runId,
                turnId: input.runContext.turnId,
                timestamp: now(),
                fromAgentId:
                    message.role === "assistant"
                        ? input.toAgentId
                        : message.role === "user"
                            ? input.fromAgentId
                            : "orchestrator",
                toAgentId:
                    message.role === "assistant"
                        ? input.fromAgentId
                        : message.role === "user"
                            ? input.toAgentId
                            : input.toAgentId,
                initiator: input.initiator,
                taskId: input.taskId,
                toolCallId: input.toolCallId,
                message,
            };
            try {
                await this.store.appendThreadMessage(envelope);
            } catch (err) {
                console.error("[runtime] appendThreadMessage failed:", errorMessage(err));
            }
            if (message.role === "user") {
                currentTurnUserEnvelopeId = envelopeId;
            }
            previousEnvelopeId = envelopeId;
        }

        const answer = extractLastAssistantText(agent.state.messages);
        const durationMs = now() - startedAt;

        await this.trace({
            type: "message_routed",
            status: "ok",
            runId: input.runContext.runId,
            turnId: input.runContext.turnId,
            agentId: input.toAgentId,
            taskId: input.taskId,
            toolCallId: input.toolCallId,
            details: {
                fromAgentId: input.fromAgentId,
                toAgentId: input.toAgentId,
                threadId,
                durationMs,
                messageCount: newMessages.length,
            },
        });

        return {
            answer,
            durationMs,
            threadId,
        };
    }

    private async appendTaskStatusMessage(
        record: TaskRecord,
        status: TaskRecord["status"],
        text: string,
    ) {
        try {
            const threadId = createThreadId(this.sessionId, ORCHESTRATOR_ID, record.agentId);
            const history = await this.store.getThreadMessages(threadId);
            const previousEnvelopeId = history.at(-1)?.envelopeId;
            const envelopeId = createId("env");
            const message: AgentMessage = {
                role: "user",
                content: `[task_status:${status}] jobId=${record.jobId} ${text}`,
                timestamp: now(),
            };

            const envelope: ThreadEnvelope = {
                envelopeId,
                parentEnvelopeId: previousEnvelopeId,
                replyToEnvelopeId: previousEnvelopeId,
                sessionId: this.sessionId,
                threadId,
                runId: record.parentRunId,
                turnId: record.parentTurnId,
                timestamp: now(),
                fromAgentId: ORCHESTRATOR_ID,
                toAgentId: record.agentId,
                initiator: "system",
                taskId: record.jobId,
                message,
            };
            await this.store.appendThreadMessage(envelope);
        } catch (err) {
            console.error("[runtime] appendTaskStatusMessage failed:", errorMessage(err));
        }
    }

    private async trace(
        input: Omit<TraceEvent, "eventId" | "timestamp" | "sessionId">,
    ) {
        const event: TraceEvent = {
            eventId: createId("evt"),
            timestamp: now(),
            sessionId: this.sessionId,
            ...input,
        };
        try {
            await this.store.appendTrace(event);
        } catch (err) {
            console.error("[runtime] trace write failed:", errorMessage(err), event.type);
        }
    }
}
