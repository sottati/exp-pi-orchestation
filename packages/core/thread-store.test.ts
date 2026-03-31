import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentChat, ThreadEnvelope, TraceEvent } from "./contracts";
import { ThreadStore } from "./thread-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
    return `/tmp/thread-store-test-${randomBytes(6).toString("hex")}`;
}

function makeChat(overrides: Partial<AgentChat> & { chatId: string; status: AgentChat["status"] }): AgentChat {
    return {
        sessionId: "sess1",
        parentRunId: "run1",
        parentTurnId: "turn1",
        agentId: "agent1",
        task: "do something",
        createdAt: 1000,
        updatedAt: 2000,
        attempts: 1,
        maxRetries: 3,
        timeoutMs: 30000,
        result: undefined,
        error: undefined,
        ...overrides,
    };
}

function makeTrace(id: string): TraceEvent {
    return {
        eventId: id,
        timestamp: Date.now(),
        sessionId: "sess1",
        runId: "run1",
        turnId: "turn1",
        type: "run_started",
        status: "ok",
    };
}

function makeEnvelope(threadId: string, idx: number): ThreadEnvelope {
    return {
        envelopeId: `env-${idx}`,
        sessionId: "sess1",
        threadId,
        runId: "run1",
        turnId: "turn1",
        timestamp: 1000 + idx,
        fromAgentId: "orchestrator",
        toAgentId: "code",
        initiator: "orchestrator",
        message: { role: "user", content: `msg ${idx}` } as any,
    };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("appendChatRecord - active chat", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("stores only minimal event (chatId, status, ts) — not full record", async () => {
        const chat = makeChat({ chatId: "chat-active", status: "active" });
        await store.appendChatRecord(chat);

        const chatsFile = join(dir, "s1", "chats.jsonl");
        const raw = await readFile(chatsFile, "utf-8");
        const parsed = JSON.parse(raw.trim());

        // Must have chatId and status
        expect(parsed.chatId).toBe("chat-active");
        expect(parsed.status).toBe("active");
        // Must NOT have heavy fields
        expect(parsed.task).toBeUndefined();
        expect(parsed.agentId).toBeUndefined();
        expect(parsed.attempts).toBeUndefined();
        // Must have ts (timestamp marker)
        expect(typeof parsed.ts).toBe("number");
    });
});

describe("appendChatRecord - waiting chat", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("stores only minimal event for waiting status", async () => {
        const chat = makeChat({ chatId: "chat-waiting", status: "waiting" });
        await store.appendChatRecord(chat);

        const chatsFile = join(dir, "s1", "chats.jsonl");
        const raw = await readFile(chatsFile, "utf-8");
        const parsed = JSON.parse(raw.trim());

        expect(parsed.chatId).toBe("chat-waiting");
        expect(parsed.status).toBe("waiting");
        expect(parsed.task).toBeUndefined();
        expect(parsed.agentId).toBeUndefined();
        expect(typeof parsed.ts).toBe("number");
    });
});

describe("appendChatRecord - closed chat", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("stores full record for closed status", async () => {
        const chat = makeChat({
            chatId: "chat-closed",
            status: "closed",
            closeReason: "completed",
            result: "done",
        });
        await store.appendChatRecord(chat);

        const chatsFile = join(dir, "s1", "chats.jsonl");
        const raw = await readFile(chatsFile, "utf-8");
        const parsed = JSON.parse(raw.trim());

        expect(parsed.chatId).toBe("chat-closed");
        expect(parsed.status).toBe("closed");
        expect(parsed.task).toBe("do something");
        expect(parsed.agentId).toBe("agent1");
        expect(parsed.closeReason).toBe("completed");
        expect(parsed.result).toBe("done");
    });
});

describe("getChatRecords - mixed sequence", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("returns full closed record when sequence is active → waiting → closed", async () => {
        const chatId = "chat-lifecycle";
        await store.appendChatRecord(makeChat({ chatId, status: "active" }));
        await store.appendChatRecord(makeChat({ chatId, status: "waiting" }));
        await store.appendChatRecord(makeChat({ chatId, status: "closed", result: "final-result" }));

        const records = await store.getChatRecords();
        expect(records.length).toBe(1);
        const record = records[0]!;
        expect(record.chatId).toBe(chatId);
        expect(record.status).toBe("closed");
        // Full record fields present
        expect(record.task).toBe("do something");
        expect(record.result).toBe("final-result");
    });
});

describe("appendTrace + getTraces", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        // Use a high limit so rotation doesn't interfere
        process.env.TRACES_MAX_LINES = "10000";
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        delete process.env.TRACES_MAX_LINES;
        await rm(dir, { recursive: true, force: true });
    });

    test("basic round-trip: appended traces are returned by getTraces", async () => {
        const t1 = makeTrace("evt-1");
        t1.timestamp = 1000;
        const t2 = makeTrace("evt-2");
        t2.timestamp = 2000;

        await store.appendTrace(t1);
        await store.appendTrace(t2);

        const traces = await store.getTraces();
        expect(traces.length).toBe(2);
        expect(traces[0]!.eventId).toBe("evt-1");
        expect(traces[1]!.eventId).toBe("evt-2");
    });
});

describe("appendTrace - rotation", () => {
    let dir: string;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
    });

    afterEach(async () => {
        delete process.env.TRACES_MAX_LINES;
        await rm(dir, { recursive: true, force: true });
    });

    test("rotates traces.jsonl when line count reaches TRACES_MAX_LINES=3 and 4 traces appended", async () => {
        process.env.TRACES_MAX_LINES = "3";
        const store = new ThreadStore({ baseDir: dir, sessionId: "s1" });

        // Append 4 traces; after the 3rd the rotation should fire
        await store.appendTrace(makeTrace("r1"));
        await store.appendTrace(makeTrace("r2"));
        await store.appendTrace(makeTrace("r3")); // rotation fires here
        await store.appendTrace(makeTrace("r4")); // written to fresh traces.jsonl

        const sessionDir = join(dir, "s1");
        const files = await readdir(sessionDir);

        // There should be a rotated file matching traces.<stamp>.jsonl
        const rotated = files.filter(f => /^traces\..+\.jsonl$/.test(f));
        expect(rotated.length).toBeGreaterThanOrEqual(1);

        // Current traces.jsonl should exist with fewer lines (just the 4th trace)
        const currentTracesPath = join(sessionDir, "traces.jsonl");
        const currentContent = await readFile(currentTracesPath, "utf-8");
        const currentLines = currentContent.trim().split("\n").filter(l => l.length > 0);
        expect(currentLines.length).toBe(1);
        expect(JSON.parse(currentLines[0]!).eventId).toBe("r4");
    });
});

describe("overwriteThread", () => {
    let dir: string;
    let store: ThreadStore;

    beforeEach(async () => {
        dir = tmpDir();
        await mkdir(dir, { recursive: true });
        store = new ThreadStore({ baseDir: dir, sessionId: "s1" });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("writes envelopes and getThreadMessages reads them back correctly", async () => {
        const threadId = "thread-overwrite-1";
        const envs = [makeEnvelope(threadId, 1), makeEnvelope(threadId, 2), makeEnvelope(threadId, 3)];

        await store.overwriteThread(threadId, envs);

        const result = await store.getThreadMessages(threadId);
        expect(result.length).toBe(3);
        expect(result[0]!.envelopeId).toBe("env-1");
        expect(result[1]!.envelopeId).toBe("env-2");
        expect(result[2]!.envelopeId).toBe("env-3");
    });

    test("overwrites existing content (not appends)", async () => {
        const threadId = "thread-overwrite-2";

        // Write initial content via appendThreadMessage
        const initial = makeEnvelope(threadId, 10);
        await store.appendThreadMessage(initial);

        // Now overwrite with new envelopes
        const newEnvs = [makeEnvelope(threadId, 20), makeEnvelope(threadId, 21)];
        await store.overwriteThread(threadId, newEnvs);

        const result = await store.getThreadMessages(threadId);
        // Should only contain the 2 new envelopes, not the original one
        expect(result.length).toBe(2);
        expect(result[0]!.envelopeId).toBe("env-20");
        expect(result[1]!.envelopeId).toBe("env-21");
    });
});
