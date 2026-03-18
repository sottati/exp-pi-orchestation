import { test, expect, describe } from "bun:test";
import { compileSystemPrompt } from "./prompt-compiler";
import type { AgentDefinition } from "./agent-builder";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

function minimalDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "test",
    name: "Test",
    role: "Test agent.",
    capabilities: [],
    modelConfig: { provider: "openrouter", modelId: "x" },
    systemPrompt: "You are a test agent.",
    rules: [],
    examples: [],
    toolRefs: [],
    delegationRules: null,
    permissions: {},
    hooks: {},
    maxConcurrency: 1,
    createAgent: () => null as any,
    ...overrides,
  };
}

function fakeTool(name: string, description: string): AgentTool<any> {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("compileSystemPrompt", () => {
  test("includes base system prompt", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).toContain("You are a test agent.");
  });

  test("includes tool descriptions", () => {
    const tools = [fakeTool("read_file", "Reads a file from disk.")];
    const result = compileSystemPrompt(minimalDef(), tools);
    expect(result).toContain("read_file");
    expect(result).toContain("Reads a file from disk.");
  });

  test("includes rules as bulleted list", () => {
    const def = minimalDef({ rules: ["Be concise.", "Always verify."] });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("- Be concise.");
    expect(result).toContain("- Always verify.");
  });

  test("includes examples as user/assistant pairs", () => {
    const def = minimalDef({
      examples: [{ user: "Fix the bug", assistant: "Let me read the file first." }],
    });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("User: Fix the bug");
    expect(result).toContain("Assistant: Let me read the file first.");
  });

  test("includes delegation info when canDelegateTo is set", () => {
    const def = minimalDef({
      delegationRules: { targets: ["math", "search"], maxDepth: 2 },
    });
    const result = compileSystemPrompt(def, []);
    expect(result).toContain("math");
    expect(result).toContain("search");
    expect(result).toContain("delegate");
  });

  test("omits delegation section when delegationRules is null", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).not.toContain("Delegation");
  });

  test("caps tool descriptions at ~4000 chars", () => {
    const longDesc = "A".repeat(500);
    const tools = Array.from({ length: 20 }, (_, i) =>
      fakeTool(`tool_${i}`, longDesc)
    );
    const result = compileSystemPrompt(minimalDef(), tools);
    const toolSection = result.split("## Rules")[0] ?? result;
    expect(toolSection.length).toBeLessThan(5000);
  });

  test("returns string without empty sections", () => {
    const result = compileSystemPrompt(minimalDef(), []);
    expect(result).not.toContain("## Rules");
    expect(result).not.toContain("## Examples");
  });
});
