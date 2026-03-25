import type { AgentChat } from "./contracts";
import { errorMessage, safeAsync } from "./errors";
import { createId, now } from "./ids";

interface RunnerContext {
    signal: AbortSignal;
    attempt: number;
}

type ChatRunner = (ctx: RunnerContext, chat: AgentChat) => Promise<string>;

interface ChatRuntimeData {
    record: AgentChat;
    controller?: AbortController;
    runner?: ChatRunner;
    timeoutHandle?: ReturnType<typeof setTimeout>;
    timeoutReject?: (err: Error) => void;
    timeoutRemainingMs?: number;
    timeoutPausedAt?: number;
}

export interface CreateChatInput {
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: string;
    task: string;
    context?: string;
    timeoutMs?: number;
    maxRetries?: number;
}

export interface ChatHooks {
    onCreated?: (chat: AgentChat) => Promise<void> | void;
    onStarted?: (chat: AgentChat) => Promise<void> | void;
    onRetry?: (chat: AgentChat) => Promise<void> | void;
    onCompleted?: (chat: AgentChat) => Promise<void> | void;
    onFailed?: (chat: AgentChat) => Promise<void> | void;
    onCancelled?: (chat: AgentChat) => Promise<void> | void;
}

export interface ChatManagerOptions {
    hooks?: ChatHooks;
    persistChat?: (chat: AgentChat) => Promise<void>;
    restoreRecords?: () => Promise<AgentChat[]>;
    getMaxConcurrency?: (agentId: string) => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 1;

export class ChatManager {
    private readonly chats = new Map<string, ChatRuntimeData>();
    private readonly activeChats = new Map<string, Set<string>>();
    private readonly waitingQueue = new Map<string, string[]>();
    private readonly hooks: ChatHooks;
    private readonly persistChat?: (chat: AgentChat) => Promise<void>;
    private readonly restoreRecords?: () => Promise<AgentChat[]>;
    private readonly getMaxConcurrency: (agentId: string) => number;

    constructor(opts: ChatManagerOptions = {}) {
        this.hooks = opts.hooks ?? {};
        this.persistChat = opts.persistChat;
        this.restoreRecords = opts.restoreRecords;
        this.getMaxConcurrency = opts.getMaxConcurrency ?? (() => 1);
    }

    private safePersist(chat: AgentChat) {
        return safeAsync(() => this.persistChat?.(chat) ?? Promise.resolve(), "chat:persist");
    }

    private safeHook(name: keyof ChatHooks, chat: AgentChat) {
        return safeAsync(async () => { await this.hooks[name]?.(chat); }, `hook:${name}`);
    }

    private markCancelled(chat: AgentChat): boolean {
        if (chat.status === "closed" && chat.closeReason === "cancelled") return false;
        chat.status = "closed";
        chat.closeReason = "cancelled";
        chat.updatedAt = now();
        chat.closedAt = chat.closedAt ?? now();
        return true;
    }

    async restore(): Promise<number> {
        if (!this.restoreRecords) return 0;
        const records = await this.restoreRecords();
        let recovered = 0;
        for (const record of records) {
            if (this.chats.has(record.chatId)) continue;
            if (record.status === "active" || record.status === "waiting") {
                record.status = "closed";
                record.closeReason = "failed";
                record.error = "Interrupted by runtime restart";
                record.updatedAt = now();
                record.closedAt = now();
                await this.safePersist(record);
                recovered++;
            }
            this.chats.set(record.chatId, { record });
        }
        return recovered;
    }

    createChat(input: CreateChatInput, runner: ChatRunner): AgentChat {
        const chat: AgentChat = {
            chatId: createId("chat"),
            sessionId: input.sessionId,
            parentRunId: input.parentRunId,
            parentTurnId: input.parentTurnId,
            agentId: input.agentId,
            task: input.task,
            context: input.context,
            status: "waiting",
            createdAt: now(),
            updatedAt: now(),
            attempts: 0,
            maxRetries: Math.max(0, input.maxRetries ?? DEFAULT_MAX_RETRIES),
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        };

        const runtimeData: ChatRuntimeData = { record: chat, runner };
        this.chats.set(chat.chatId, runtimeData);

        const active = this.activeChats.get(input.agentId) ?? new Set();
        this.activeChats.set(input.agentId, active);
        const maxConcurrency = this.getMaxConcurrency(input.agentId);

        if (active.size < maxConcurrency) {
            chat.status = "active";
            active.add(chat.chatId);
            void this.safePersist(chat);
            void this.safeHook("onCreated", chat);
            void this.execute(chat.chatId, runner).catch(err =>
                console.error("[ChatManager] execute:", err)
            );
        } else {
            const queue = this.waitingQueue.get(input.agentId) ?? [];
            queue.push(chat.chatId);
            this.waitingQueue.set(input.agentId, queue);
            void this.safePersist(chat);
            void this.safeHook("onCreated", chat);
        }

        return { ...chat };
    }

    getChat(chatId: string): AgentChat | undefined {
        const runtime = this.chats.get(chatId);
        return runtime ? { ...runtime.record } : undefined;
    }

    closeChat(chatId: string): AgentChat | undefined {
        const runtime = this.chats.get(chatId);
        if (!runtime) return undefined;
        if (runtime.record.status === "closed") return { ...runtime.record };

        // Remove from waiting queue if queued
        if (runtime.record.status === "waiting") {
            const queue = this.waitingQueue.get(runtime.record.agentId);
            if (queue) {
                const idx = queue.indexOf(chatId);
                if (idx >= 0) queue.splice(idx, 1);
            }
        }

        const changed = this.markCancelled(runtime.record);
        runtime.controller?.abort();
        if (changed) {
            void this.safePersist(runtime.record);
            void this.safeHook("onCancelled", runtime.record);
        }

        this.dequeueNext(runtime.record.agentId);

        return { ...runtime.record };
    }

    listChats(): AgentChat[] {
        return [...this.chats.values()]
            .map(c => ({ ...c.record }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getQueuePosition(chatId: string): number | undefined {
        const chat = this.chats.get(chatId);
        if (!chat || chat.record.status !== "waiting") return undefined;
        const queue = this.waitingQueue.get(chat.record.agentId) ?? [];
        const index = queue.indexOf(chatId);
        return index >= 0 ? index + 1 : undefined;
    }

    pauseTimeout(chatId: string): void {
        const runtime = this.chats.get(chatId);
        if (!runtime || !runtime.timeoutHandle) return;
        clearTimeout(runtime.timeoutHandle);
        runtime.timeoutHandle = undefined;
        const elapsed = Date.now() - (runtime.record.startedAt ?? Date.now());
        runtime.timeoutRemainingMs = Math.max(0, runtime.record.timeoutMs - elapsed);
        runtime.timeoutPausedAt = Date.now();
    }

    resumeTimeout(chatId: string): void {
        const runtime = this.chats.get(chatId);
        if (!runtime || runtime.timeoutHandle || !runtime.timeoutPausedAt) return;
        const remainingMs = runtime.timeoutRemainingMs ?? runtime.record.timeoutMs;
        runtime.timeoutPausedAt = undefined;
        const reject = runtime.timeoutReject;
        if (!reject) return;
        runtime.timeoutHandle = setTimeout(() => {
            runtime.controller?.abort();
            reject(new Error(`Chat timeout after ${runtime.record.timeoutMs}ms`));
        }, remainingMs);
    }

    private dequeueNext(agentId: string) {
        const active = this.activeChats.get(agentId);
        if (!active) return;

        for (const id of active) {
            const c = this.chats.get(id);
            if (c && c.record.status === "closed") active.delete(id);
        }

        const maxConcurrency = this.getMaxConcurrency(agentId);
        const queue = this.waitingQueue.get(agentId);

        while (queue && queue.length > 0 && active.size < maxConcurrency) {
            const nextId = queue.shift()!;
            const next = this.chats.get(nextId);
            if (!next || !next.runner || next.record.status !== "waiting") continue;

            next.record.status = "active";
            next.record.updatedAt = now();
            active.add(nextId);
            void this.safePersist(next.record);
            void this.execute(nextId, next.runner).catch(err =>
                console.error("[ChatManager] execute:", err)
            );
        }
    }

    private async execute(chatId: string, runner: ChatRunner) {
        const runtime = this.chats.get(chatId);
        if (!runtime) return;

        while (runtime.record.attempts <= runtime.record.maxRetries) {
            if (runtime.record.status === "closed") return;

            runtime.record.attempts += 1;
            runtime.record.updatedAt = now();
            runtime.record.startedAt ??= now();
            runtime.controller = new AbortController();
            await this.safePersist(runtime.record);
            await this.safeHook("onStarted", runtime.record);

            try {
                const timeoutMs = runtime.timeoutRemainingMs ?? runtime.record.timeoutMs;
                const timeoutPromise = new Promise<string>((_, reject) => {
                    runtime.timeoutReject = reject;
                    runtime.timeoutHandle = setTimeout(() => {
                        runtime.controller?.abort();
                        reject(new Error(`Chat timeout after ${runtime.record.timeoutMs}ms`));
                    }, timeoutMs);
                });

                const result = await Promise.race([
                    runner({ signal: runtime.controller.signal, attempt: runtime.record.attempts }, runtime.record),
                    timeoutPromise,
                ]);

                if (runtime.timeoutHandle) {
                    clearTimeout(runtime.timeoutHandle);
                    runtime.timeoutHandle = undefined;
                }

                runtime.record.result = result;
                runtime.record.status = "closed";
                runtime.record.closeReason = "completed";
                runtime.record.updatedAt = now();
                runtime.record.closedAt = now();
                await this.safePersist(runtime.record);
                await this.safeHook("onCompleted", runtime.record);
                this.dequeueNext(runtime.record.agentId);
                return;
            } catch (error) {
                if (runtime.timeoutHandle) {
                    clearTimeout(runtime.timeoutHandle);
                    runtime.timeoutHandle = undefined;
                }

                if (runtime.controller.signal.aborted) {
                    const changed = this.markCancelled(runtime.record);
                    if (changed) {
                        await this.safePersist(runtime.record);
                        await this.safeHook("onCancelled", runtime.record);
                        this.dequeueNext(runtime.record.agentId);
                    }
                    return;
                }

                runtime.record.error = errorMessage(error);
                runtime.record.updatedAt = now();

                if (runtime.record.attempts <= runtime.record.maxRetries) {
                    await this.safePersist(runtime.record);
                    await this.safeHook("onRetry", runtime.record);
                    continue;
                }

                runtime.record.status = "closed";
                runtime.record.closeReason = "failed";
                runtime.record.closedAt = now();
                await this.safePersist(runtime.record);
                await this.safeHook("onFailed", runtime.record);
                this.dequeueNext(runtime.record.agentId);
                return;
            }
        }
    }
}
