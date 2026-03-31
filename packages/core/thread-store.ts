import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentChat, ScheduledJob, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage, safeParseLine } from "./errors";

function hashId(value: string): string {
    return createHash("sha1").update(value).digest("hex");
}

function parseJsonLines<T>(data: string): T[] {
    return data
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => safeParseLine<T>(line))
        .filter((item): item is T => item !== undefined);
}

export interface ThreadStoreOptions {
    baseDir?: string;
    sessionId: string;
}

export class ThreadStore {
    readonly sessionId: string;
    private readonly sessionDir: string;
    private readonly threadsDir: string;
    private readonly tracesFile: string;
    private readonly chatsFile: string;
    private readonly jobsFile: string;
    private readonly ready: Promise<void>;

    constructor(opts: ThreadStoreOptions) {
        this.sessionId = opts.sessionId;
        this.sessionDir = join(opts.baseDir ?? ".runtime-data", this.sessionId);
        this.threadsDir = join(this.sessionDir, "threads");
        this.tracesFile = join(this.sessionDir, "traces.jsonl");
        this.chatsFile = join(this.sessionDir, "chats.jsonl");
        this.jobsFile = join(this.sessionDir, "jobs.jsonl");
        this.ready = this.ensureDirectories();
    }

    private async ensureDirectories() {
        try {
            await mkdir(this.threadsDir, { recursive: true });
        } catch (err) {
            throw new Error(`Fatal: cannot create data directories: ${errorMessage(err)}`);
        }
    }

    private async appendJsonl(path: string, payload: unknown) {
        await this.ready;
        try {
            await appendFile(path, JSON.stringify(payload) + "\n", "utf-8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            // Directory was deleted at runtime — recreate and retry once.
            await mkdir(this.threadsDir, { recursive: true });
            await appendFile(path, JSON.stringify(payload) + "\n", "utf-8");
        }
    }

    private async readFile(path: string): Promise<string> {
        try {
            return await Bun.file(path).text();
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw err;
        }
    }

    private threadPath(threadId: string): string {
        return join(this.threadsDir, `${hashId(threadId)}.jsonl`);
    }

    async appendThreadMessage(envelope: ThreadEnvelope) {
        await this.appendJsonl(this.threadPath(envelope.threadId), envelope);
    }

    async getThreadMessages(threadId: string): Promise<ThreadEnvelope[]> {
        const data = await this.readFile(this.threadPath(threadId));
        const rows = parseJsonLines<ThreadEnvelope>(data);
        return rows.sort((a, b) => a.timestamp - b.timestamp);
    }

    async listThreadIds(): Promise<string[]> {
        await this.ready;
        const files = await readdir(this.threadsDir);
        const ids = new Set<string>();
        for (const fileName of files) {
            if (!fileName.endsWith(".jsonl")) continue;
            const fullPath = join(this.threadsDir, fileName);
            const data = await this.readFile(fullPath);
            const rows = parseJsonLines<ThreadEnvelope>(data);
            for (const row of rows) {
                ids.add(row.threadId);
            }
        }
        return [...ids].sort();
    }

    async appendTrace(event: TraceEvent) {
        await this.appendJsonl(this.tracesFile, event);
    }

    async getTraces(): Promise<TraceEvent[]> {
        const data = await this.readFile(this.tracesFile);
        const rows = parseJsonLines<TraceEvent>(data);
        return rows.sort((a, b) => a.timestamp - b.timestamp);
    }

    async appendChatRecord(chat: AgentChat) {
        await this.appendJsonl(this.chatsFile, chat);
    }

    async getChatRecords(): Promise<AgentChat[]> {
        const data = await this.readFile(this.chatsFile);
        const rows = parseJsonLines<AgentChat>(data);
        const byChatId = new Map<string, AgentChat>();
        for (const row of rows) {
            byChatId.set(row.chatId, row);
        }
        return [...byChatId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async appendJob(job: ScheduledJob) {
        await this.appendJsonl(this.jobsFile, job);
    }

    async getJobRecords(): Promise<ScheduledJob[]> {
        const data = await this.readFile(this.jobsFile);
        const rows = parseJsonLines<ScheduledJob>(data);
        const byJobId = new Map<string, ScheduledJob>();
        for (const row of rows) {
            byJobId.set(row.jobId, row);
        }
        return [...byJobId.values()];
    }
}
