import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryClient } from "./memory-client";
import type { SaveParams } from "./memory-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCompleteSimple = mock(async (_model: any, _ctx: any): Promise<AssistantMessage> => {
  return fakeAssistantMessage("Summary text");
});

mock.module("@mariozechner/pi-ai", () => ({
  completeSimple: mockCompleteSimple,
}));

// Import AFTER mock.module
const { maybeCompact } = await import("./compaction");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as Message;
}

function makeMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => makeUserMessage(`Message ${i + 1}`));
}

function makeAssistantToolCallMessage(callId: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "get_chat_status", arguments: { chatId: "chat_1" } }],
    api: "openai",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as any;
}

function makeToolResultMessage(callId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "get_chat_status",
    content: [{ type: "text", text: "chat active" }],
    timestamp: Date.now(),
  } as any;
}

function makeMockClient(overrides?: Partial<MemoryClient>): MemoryClient {
  return {
    save: async (_params: SaveParams): Promise<number | undefined> => 1,
    search: async (_query: string): Promise<any[]> => [],
    ...overrides,
  } as unknown as MemoryClient;
}

function makeFakeModel(): any {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

// ---------------------------------------------------------------------------
// Reset mock before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCompleteSimple.mockReset();
  mockCompleteSimple.mockImplementation(async () => fakeAssistantMessage("Summary text"));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maybeCompact", () => {
  test("1. Returns null when messages.length <= threshold", async () => {
    const messages = makeMessages(10);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });
    expect(result).toBeNull();
  });

  test("2. Returns null when messages.length === threshold (boundary)", async () => {
    const messages = makeMessages(40);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });
    expect(result).toBeNull();
  });

  test("3. Triggers when messages.length > threshold — returns array starting with summary message", async () => {
    const messages = makeMessages(41);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  test("4. Returned array has length = keep + 1 (summary + recent messages)", async () => {
    const keep = 10;
    const messages = makeMessages(50);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(keep + 1);
  });

  test("5. Summary message has role 'user' and starts with '[Conversation summary:'", async () => {
    const messages = makeMessages(50);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });
    expect(result).not.toBeNull();
    const summaryMsg = result![0] as Message;
    expect(summaryMsg.role).toBe("user");
    expect(typeof summaryMsg.content === "string" && summaryMsg.content.startsWith("[Conversation summary:")).toBe(true);
  });

  test("6. completeSimple is called with the correct number of messages (toCompact filtered to LLM-compatible)", async () => {
    const keep = 10;
    const total = 50;
    const messages = makeMessages(total);
    // All messages are user messages (LLM-compatible), so toCompact = total - keep = 40 messages
    await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep,
    });
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const callArgs = mockCompleteSimple.mock.calls[0]!;
    const context = callArgs[1] as { messages: Message[] };
    // completeSimple is called with a single user prompt message (not the toCompact messages directly)
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]!.role).toBe("user");
  });

  test("7. client.save is called with type 'conversation_summary'", async () => {
    let capturedParams: SaveParams | undefined;
    const client = makeMockClient({
      save: async (params) => {
        capturedParams = params;
        return 42;
      },
    });
    const messages = makeMessages(50);
    await maybeCompact({
      messages,
      model: makeFakeModel(),
      client,
      threshold: 40,
      keep: 10,
    });
    expect(capturedParams).toBeDefined();
    expect(capturedParams!.type).toBe("conversation_summary");
  });

  test("8. Returns null if completeSimple throws (non-fatal)", async () => {
    mockCompleteSimple.mockImplementation(async () => {
      throw new Error("LLM error");
    });
    const messages = makeMessages(50);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });
    expect(result).toBeNull();
  });

  test("9. Returns compacted messages even if client.save fails (non-fatal)", async () => {
    const client = makeMockClient({
      save: async () => {
        throw new Error("engram unavailable");
      },
    });
    const keep = 10;
    const messages = makeMessages(50);
    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client,
      threshold: 40,
      keep,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(keep + 1);
  });

  test("10. Uses env vars COMPACTION_THRESHOLD and COMPACTION_KEEP when not in params", async () => {
    const origThreshold = process.env.COMPACTION_THRESHOLD;
    const origKeep = process.env.COMPACTION_KEEP;
    process.env.COMPACTION_THRESHOLD = "5";
    process.env.COMPACTION_KEEP = "3";

    try {
      // 6 messages > threshold of 5 → should compact
      const messages = makeMessages(6);
      const result = await maybeCompact({
        messages,
        model: makeFakeModel(),
        client: makeMockClient(),
      });
      expect(result).not.toBeNull();
      // keep=3, so result should be 3 + 1 = 4
      expect(result!.length).toBe(4);
    } finally {
      if (origThreshold === undefined) {
        delete process.env.COMPACTION_THRESHOLD;
      } else {
        process.env.COMPACTION_THRESHOLD = origThreshold;
      }
      if (origKeep === undefined) {
        delete process.env.COMPACTION_KEEP;
      } else {
        process.env.COMPACTION_KEEP = origKeep;
      }
    }
  });

  test("11. Expands keep window when compaction boundary starts at toolResult", async () => {
    const callId = "call_boundary";
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 34; i++) messages.push(makeUserMessage(`Message ${i + 1}`));
    messages.push(makeAssistantToolCallMessage(callId)); // index 34 (toCompact by default)
    messages.push(makeToolResultMessage(callId)); // index 35 (first of toKeep by default)
    for (let i = 36; i < 45; i++) messages.push(makeUserMessage(`Message ${i + 1}`));

    const result = await maybeCompact({
      messages,
      model: makeFakeModel(),
      client: makeMockClient(),
      threshold: 40,
      keep: 10,
    });

    expect(result).not.toBeNull();
    const compacted = result!;
    const hasAssistantCall = compacted.some((m) => {
      const typed = m as { role?: unknown; content?: unknown };
      if (typed.role !== "assistant" || !Array.isArray(typed.content)) return false;
      return typed.content.some((c) => typeof c === "object" && c !== null && (c as { id?: unknown }).id === callId);
    });
    const hasToolResult = compacted.some((m) => {
      const typed = m as { role?: unknown; toolCallId?: unknown };
      return typed.role === "toolResult" && typed.toolCallId === callId;
    });

    expect(hasAssistantCall).toBe(true);
    expect(hasToolResult).toBe(true);
  });
});
