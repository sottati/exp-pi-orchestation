import { test, expect, describe } from "bun:test";
import { createAgentDefinitions, ORCHESTRATOR_ID } from "./agents";
import type { AgentDefinition } from "./agent-builder";

describe("Agent definitions v2", () => {
  test("createAgentDefinitions returns orchestrator, code, and math", () => {
    const defs = createAgentDefinitions();
    const ids = defs.map((d) => d.id);
    expect(ids).toContain(ORCHESTRATOR_ID);
    expect(ids).toContain("code");
    expect(ids).toContain("math");
  });

  test("each definition has required fields", () => {
    const defs = createAgentDefinitions();
    for (const def of defs) {
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.modelConfig.provider).toBeTruthy();
      expect(def.modelConfig.modelId).toBeTruthy();
      expect(def.systemPrompt).toBeTruthy();
      expect(typeof def.createAgent).toBe("function");
    }
  });

  test("orchestrator has delegation-related tool refs", () => {
    const defs = createAgentDefinitions();
    const orch = defs.find((d) => d.id === ORCHESTRATOR_ID)!;
    // Orchestrator's built-in tools are registered separately by the runtime
    // But it should have an empty or specific toolRefs
    expect(orch.toolRefs).toBeDefined();
  });

  test("math specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const math = defs.find((d) => d.id === "math")!;
    expect(math.maxConcurrency).toBe(1);
  });

  test("code specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const code = defs.find((d) => d.id === "code")!;
    expect(code.maxConcurrency).toBe(1);
  });
});
