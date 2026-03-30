import { test, expect, describe } from "bun:test";
import { createAgentDefinitions, ORCHESTRATOR_ID } from "./agents";
import type { AgentDefinition } from "./agent-builder";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceManager } from "./workspace-manager";

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

  test("orchestrator has local file tools gated by HITL", () => {
    const defs = createAgentDefinitions();
    const orch = defs.find((d) => d.id === ORCHESTRATOR_ID)!;
    const localToolNames = (orch.localTools ?? []).map((tool) => tool.name).sort();
    expect(localToolNames).toEqual(["list_directory", "mem_get", "mem_save", "read_file", "request_credentials", "run_command", "search_code"]);
    expect(orch.permissions["read_file"]).toBe("hitl");
    expect(orch.permissions["search_code"]).toBe("hitl");
    expect(orch.permissions["list_directory"]).toBe("hitl");
    expect(orch.permissions["run_command"]).toBe("hitl");
    expect(orch.permissions["request_credentials"]).toBe("hitl");
  });

  test("code, debugger, and web-designer require HITL for list_directory", () => {
    const defs = createAgentDefinitions();
    const byId = Object.fromEntries(defs.map((d) => [d.id, d] as const)) as Record<string, AgentDefinition>;
    expect(byId["code"]!.permissions["list_directory"]).toBe("hitl");
    expect(byId["debugger"]!.permissions["list_directory"]).toBe("hitl");
    expect(byId["web-designer"]!.permissions["list_directory"]).toBe("hitl");
  });

  test("explorer requires HITL for page access", () => {
    const defs = createAgentDefinitions();
    const explorer = defs.find((d) => d.id === "explorer")!;
    expect(explorer.permissions["browse_url"]).toBe("hitl");
    expect(explorer.permissions["interact_page"]).toBe("hitl");
  });

  test("math specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const math = defs.find((d) => d.id === "math")!;
    expect(math.maxConcurrency).toBe(1);
  });

  test("all agents get default skills config", () => {
    const defs = createAgentDefinitions();
    for (const def of defs) {
      expect(def.skillsConfig).toBeDefined();
      expect(def.skillsConfig?.enabled).toBe(true);
      expect(def.skillsConfig?.roots).toEqual(["skills"]);
    }
  });

  test("code specialist has maxConcurrency 1", () => {
    const defs = createAgentDefinitions();
    const code = defs.find((d) => d.id === "code")!;
    expect(code.maxConcurrency).toBe(1);
  });

  test("code and web-designer expose workspace/git tools when workspace manager is provided", () => {
    const tmpDir = join(import.meta.dir, "__agents_workspace_test__");
    mkdirSync(tmpDir, { recursive: true });
    const manager = new WorkspaceManager({
      dataDir: join(tmpDir, ".runtime-data-test"),
      allowedRoots: [tmpDir],
    });
    manager.registerWorkspace({ path: tmpDir, workspaceId: "tmp", name: "tmp", setActive: true });

    try {
      const defs = createAgentDefinitions({ workspaceManager: manager });
      const code = defs.find((d) => d.id === "code")!;
      const webDesigner = defs.find((d) => d.id === "web-designer")!;

      const codeTools = (code.localTools ?? []).map((tool) => tool.name);
      const webTools = (webDesigner.localTools ?? []).map((tool) => tool.name);

      expect(codeTools).toContain("workspace_list");
      expect(codeTools).toContain("workspace_set_active");
      expect(codeTools).toContain("git_status");
      expect(codeTools).toContain("github_create_pr");

      expect(webTools).toContain("workspace_list");
      expect(webTools).toContain("workspace_set_active");
      expect(webTools).toContain("git_status");
      expect(webTools).toContain("github_create_pr");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
