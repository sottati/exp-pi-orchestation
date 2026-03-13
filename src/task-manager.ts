import type { TaskRecord } from "./contracts";
import { errorMessage, safeAsync } from "./errors";
import { createId, now } from "./ids";

export interface TaskExecutionPolicy {
    timeoutMs?: number;
    maxRetries?: number;
}

interface RunnerContext {
    signal: AbortSignal;
    attempt: number;
}

type TaskRunner = (ctx: RunnerContext, record: TaskRecord) => Promise<string>;

interface TaskRuntimeData {
    record: TaskRecord;
    controller?: AbortController;
}

interface CreateTaskInput {
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: TaskRecord["agentId"];
    task: string;
    context?: string;
    policy?: TaskExecutionPolicy;
}

interface TaskHooks {
    onQueued?: (record: TaskRecord) => Promise<void> | void;
    onStarted?: (record: TaskRecord) => Promise<void> | void;
    onRetry?: (record: TaskRecord) => Promise<void> | void;
    onCompleted?: (record: TaskRecord) => Promise<void> | void;
    onFailed?: (record: TaskRecord) => Promise<void> | void;
    onCancelled?: (record: TaskRecord) => Promise<void> | void;
}

interface TaskManagerOptions {
    hooks?: TaskHooks;
    persistTask?: (record: TaskRecord) => Promise<void>;
    restoreRecords?: () => Promise<TaskRecord[]>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 1;

export class TaskManager {
    private readonly tasks = new Map<string, TaskRuntimeData>();
    private readonly hooks: TaskHooks;
    private readonly persistTask?: (record: TaskRecord) => Promise<void>;
    private readonly restoreRecords?: () => Promise<TaskRecord[]>;

    constructor(opts: TaskManagerOptions = {}) {
        this.hooks = opts.hooks ?? {};
        this.persistTask = opts.persistTask;
        this.restoreRecords = opts.restoreRecords;
    }

    private safePersist(record: TaskRecord) {
        return safeAsync(() => this.persistTask?.(record) ?? Promise.resolve(), "task:persist");
    }

    private safeHook(name: keyof TaskHooks, record: TaskRecord) {
        return safeAsync(async () => { await this.hooks[name]?.(record); }, `hook:${name}`);
    }

    async restore(): Promise<number> {
        if (!this.restoreRecords) return 0;
        const records = await this.restoreRecords();
        let recovered = 0;
        for (const record of records) {
            if (this.tasks.has(record.jobId)) continue;
            if (record.status === "queued" || record.status === "running") {
                record.status = "failed";
                record.error = "Interrupted by runtime restart";
                record.updatedAt = now();
                record.finishedAt = now();
                await this.safePersist(record);
                recovered++;
            }
            this.tasks.set(record.jobId, { record });
        }
        return recovered;
    }

    createTask(input: CreateTaskInput, runner: TaskRunner): TaskRecord {
        const record: TaskRecord = {
            jobId: createId("job"),
            sessionId: input.sessionId,
            parentRunId: input.parentRunId,
            parentTurnId: input.parentTurnId,
            agentId: input.agentId,
            task: input.task,
            context: input.context,
            status: "queued",
            createdAt: now(),
            updatedAt: now(),
            attempts: 0,
            timeoutMs: input.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: Math.max(0, input.policy?.maxRetries ?? DEFAULT_MAX_RETRIES),
        };

        this.tasks.set(record.jobId, { record });
        void this.safePersist(record);
        void this.safeHook("onQueued", record);
        void this.execute(record.jobId, runner).catch(err => console.error("[TaskManager] execute:", err));
        return { ...record };
    }

    getTask(jobId: string): TaskRecord | undefined {
        const runtime = this.tasks.get(jobId);
        if (!runtime) {
            return undefined;
        }
        return { ...runtime.record };
    }

    cancelTask(jobId: string): TaskRecord | undefined {
        const runtime = this.tasks.get(jobId);
        if (!runtime) {
            return undefined;
        }
        runtime.controller?.abort();
        runtime.record.status = "cancelled";
        runtime.record.updatedAt = now();
        runtime.record.finishedAt = now();
        void this.safePersist(runtime.record);
        void this.safeHook("onCancelled", runtime.record);
        return { ...runtime.record };
    }

    listTasks(): TaskRecord[] {
        return [...this.tasks.values()]
            .map((task) => ({ ...task.record }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    private async execute(jobId: string, runner: TaskRunner) {
        const runtime = this.tasks.get(jobId);
        if (!runtime) {
            return;
        }

        while (runtime.record.attempts <= runtime.record.maxRetries) {
            if (runtime.record.status === "cancelled") {
                return;
            }

            runtime.record.attempts += 1;
            runtime.record.status = "running";
            runtime.record.updatedAt = now();
            runtime.record.startedAt ??= now();
            runtime.controller = new AbortController();
            await this.safePersist(runtime.record);
            await this.safeHook("onStarted", runtime.record);

            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                const timeoutPromise = new Promise<string>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        runtime.controller?.abort();
                        reject(new Error(`Task timeout after ${runtime.record.timeoutMs}ms`));
                    }, runtime.record.timeoutMs);
                });

                const result = await Promise.race([
                    runner({ signal: runtime.controller.signal, attempt: runtime.record.attempts }, runtime.record),
                    timeoutPromise,
                ]);

                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                runtime.record.result = result;
                runtime.record.status = "completed";
                runtime.record.updatedAt = now();
                runtime.record.finishedAt = now();
                await this.safePersist(runtime.record);
                await this.safeHook("onCompleted", runtime.record);
                return;
            } catch (error) {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                if (runtime.controller.signal.aborted) {
                    runtime.record.status = "cancelled";
                    runtime.record.updatedAt = now();
                    runtime.record.finishedAt = now();
                    await this.safePersist(runtime.record);
                    await this.safeHook("onCancelled", runtime.record);
                    return;
                }

                runtime.record.error = errorMessage(error);
                runtime.record.updatedAt = now();

                if (runtime.record.attempts <= runtime.record.maxRetries) {
                    await this.safePersist(runtime.record);
                    await this.safeHook("onRetry", runtime.record);
                    continue;
                }

                runtime.record.status = "failed";
                runtime.record.finishedAt = now();
                await this.safePersist(runtime.record);
                await this.safeHook("onFailed", runtime.record);
                return;
            }
        }
    }
}
