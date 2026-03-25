import { test, expect, describe } from "bun:test";
import { ToolRegistry, type ToolEntry } from "./tool-registry";
import { Type } from "@sinclair/typebox";

function makeTool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    name: overrides.name ?? "test_tool",
    source: overrides.source ?? "local",
    description: overrides.description ?? "A test tool",
    parameters: overrides.parameters ?? Type.Object({}),
    execute: overrides.execute ?? (async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    })),
    defaultPermission: overrides.defaultPermission ?? "allow",
    available: overrides.available ?? true,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  test("register and get a local tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool({ name: "read_file" });
    registry.register(tool);
    const found = registry.get("read_file");
    expect(found).toBeDefined();
    expect(found!.name).toBe("read_file");
  });

  test("get returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("list returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    expect(registry.list().length).toBe(2);
  });

  test("resolve returns tools by exact name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    registry.register(makeTool({ name: "write_file" }));
    const resolved = registry.resolve(["read_file"]);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.name).toBe("read_file");
  });

  test("resolve supports glob pattern with *", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "mcp:filesystem/read" }));
    registry.register(makeTool({ name: "mcp:filesystem/write" }));
    registry.register(makeTool({ name: "mcp:git/status" }));
    const resolved = registry.resolve(["mcp:filesystem/*"]);
    expect(resolved.length).toBe(2);
    expect(resolved.map(t => t.name).sort()).toEqual([
      "mcp:filesystem/read",
      "mcp:filesystem/write",
    ]);
  });

  test("resolve skips unavailable tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "mcp:fs/read", available: false }));
    registry.register(makeTool({ name: "mcp:fs/write", available: true }));
    const resolved = registry.resolve(["mcp:fs/*"]);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.name).toBe("mcp:fs/write");
  });

  test("resolve deduplicates when multiple refs match same tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    const resolved = registry.resolve(["read_file", "read_file"]);
    expect(resolved.length).toBe(1);
  });

  test("register overwrites existing tool with same name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "x", description: "old" }));
    registry.register(makeTool({ name: "x", description: "new" }));
    expect(registry.get("x")!.description).toBe("new");
    expect(registry.list().length).toBe(1);
  });

  test("connectMcp registers tools and disconnectMcp removes them", async () => {
    const registry = new ToolRegistry();
    await registry.connectMcp("fs", {
      discover: async () => [
        { name: "read", description: "Read file", inputSchema: {} },
        { name: "write", description: "Write file", inputSchema: {} },
      ],
      callTool: async (_name, _params) => "ok",
      disconnect: async () => {},
    });
    expect(registry.get("mcp:fs/read")).toBeDefined();
    expect(registry.get("mcp:fs/write")).toBeDefined();
    expect(registry.list().filter(t => t.source === "mcp").length).toBe(2);
    await registry.disconnectMcp("fs");
    expect(registry.get("mcp:fs/read")).toBeUndefined();
    expect(registry.get("mcp:fs/write")).toBeUndefined();
  });

  test("connectMcp throws on failure", async () => {
    const registry = new ToolRegistry();
    await expect(registry.connectMcp("bad", {
      discover: async () => { throw new Error("connection refused"); },
      callTool: async () => "",
      disconnect: async () => {},
    })).rejects.toThrow("connection refused");
  });
});
