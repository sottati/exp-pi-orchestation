import { test, expect, describe } from "bun:test";
import { createMemoryToolEntries } from "./memory-tools";
import type { MemoryClient } from "./memory-client";
import type { MemoryResult, SaveParams } from "./memory-client";

function makeMockClient(overrides?: Partial<MemoryClient>): MemoryClient {
  return {
    save: async (_params: SaveParams): Promise<number | undefined> => 42,
    search: async (_query: string, _limit?: number): Promise<MemoryResult[]> => [],
    ...overrides,
  } as unknown as MemoryClient;
}

describe("mem_save", () => {
  test("success — formats content correctly and returns id", async () => {
    let capturedParams: SaveParams | undefined;
    const client = makeMockClient({
      save: async (params) => {
        capturedParams = params;
        return 99;
      },
    });

    const [memSave] = createMemoryToolEntries(client);
    const result = await memSave!.execute("call-1", {
      title: "Use Bun over Node",
      type: "decision",
      what: "We decided to use Bun as the runtime",
      why: "Bun is faster and has built-in TypeScript support",
      learned: "Always prefer Bun in this project",
    });

    expect(capturedParams).toEqual({
      type: "decision",
      title: "Use Bun over Node",
      content: "What: We decided to use Bun as the runtime\nWhy: Bun is faster and has built-in TypeScript support\nLearned: Always prefer Bun in this project",
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Memory saved (id: 99)",
    });
  });

  test("with optional where — where is included in content", async () => {
    let capturedContent: string | undefined;
    const client = makeMockClient({
      save: async (params) => {
        capturedContent = params.content;
        return 1;
      },
    });

    const [memSave] = createMemoryToolEntries(client);
    await memSave!.execute("call-2", {
      title: "Bug in parser",
      type: "bug",
      what: "Off-by-one error in CSV parser",
      why: "Caused data truncation",
      where: "packages/core/analyst-tools.ts",
      learned: "Check boundary conditions in parser",
    });

    expect(capturedContent).toContain("\nWhere: packages/core/analyst-tools.ts\n");
    expect(capturedContent).toBe(
      "What: Off-by-one error in CSV parser\nWhy: Caused data truncation\nWhere: packages/core/analyst-tools.ts\nLearned: Check boundary conditions in parser",
    );
  });

  test("without where — where is NOT in content", async () => {
    let capturedContent: string | undefined;
    const client = makeMockClient({
      save: async (params) => {
        capturedContent = params.content;
        return 2;
      },
    });

    const [memSave] = createMemoryToolEntries(client);
    await memSave!.execute("call-3", {
      title: "Prefer small functions",
      type: "preference",
      what: "Keep functions under 30 lines",
      why: "Readability and testability",
      learned: "Always refactor large functions",
    });

    expect(capturedContent).not.toContain("Where:");
    expect(capturedContent).toBe(
      "What: Keep functions under 30 lines\nWhy: Readability and testability\nLearned: Always refactor large functions",
    );
  });

  test("engram unavailable (save returns undefined) — fallback message", async () => {
    const client = makeMockClient({
      save: async (_params) => undefined,
    });

    const [memSave] = createMemoryToolEntries(client);
    const result = await memSave!.execute("call-4", {
      title: "Some memory",
      type: "pattern",
      what: "Something happened",
      why: "It matters",
      learned: "Remember this",
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Memory saved (engram unavailable)",
    });
  });
});

describe("mem_get", () => {
  test("success with results — formats output correctly", async () => {
    let capturedQuery: string | undefined;
    let capturedLimit: number | undefined;

    const mockResults: MemoryResult[] = [
      { id: 1, title: "Bun runtime decision", type: "decision", content: "What: Use Bun\nWhy: Speed\nLearned: Always use Bun" },
      { id: 2, title: "Small functions", type: "preference", content: "What: Keep small\nWhy: Readability\nLearned: Refactor" },
    ];

    const client = makeMockClient({
      search: async (query, limit) => {
        capturedQuery = query;
        capturedLimit = limit;
        return mockResults;
      },
    });

    const [, memGet] = createMemoryToolEntries(client);
    const result = await memGet!.execute("call-5", {
      query: "bun runtime",
      limit: 10,
    });

    expect(capturedQuery).toBe("bun runtime");
    expect(capturedLimit).toBe(10);

    const text = (result.content[0] as { type: "text"; text: string })?.text;
    expect(text).toContain("[1] Bun runtime decision (decision)");
    expect(text).toContain("What: Use Bun\nWhy: Speed\nLearned: Always use Bun");
    expect(text).toContain("[2] Small functions (preference)");
    expect(text).toContain("\n\n");
  });

  test("no results — returns 'No relevant memories found.'", async () => {
    const client = makeMockClient({
      search: async (_query, _limit) => [],
    });

    const [, memGet] = createMemoryToolEntries(client);
    const result = await memGet!.execute("call-6", {
      query: "something obscure",
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "No relevant memories found.",
    });
  });

  test("default limit — search called with limit=5 when not specified", async () => {
    let capturedLimit: number | undefined;

    const client = makeMockClient({
      search: async (_query, limit) => {
        capturedLimit = limit;
        return [];
      },
    });

    const [, memGet] = createMemoryToolEntries(client);
    await memGet!.execute("call-7", {
      query: "anything",
    });

    expect(capturedLimit).toBe(5);
  });
});
