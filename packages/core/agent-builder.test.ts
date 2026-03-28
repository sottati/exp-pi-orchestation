import { test, expect, describe } from "bun:test";
import { defineAgent, type AgentDefinition } from "./agent-builder";

describe("defineAgent builder", () => {
  test("builds minimal agent definition", () => {
    const def = defineAgent("code")
      .name("Code Specialist")
      .role("Creates code snippets.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You are a coding specialist.")
      .build();

    expect(def.id).toBe("code");
    expect(def.name).toBe("Code Specialist");
    expect(def.role).toBe("Creates code snippets.");
    expect(def.modelConfig.provider).toBe("openrouter");
    expect(def.modelConfig.modelId).toBe("google/gemini-3.1-flash-lite-preview");
    expect(def.systemPrompt).toBe("You are a coding specialist.");
    expect(def.maxConcurrency).toBe(1);
  });

  test("builds agent with all options", () => {
    const def = defineAgent("code")
      .name("Code Specialist")
      .role("Creates code.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You are a coder.")
      .rules(["Always read before modifying.", "Be concise."])
      .examples([{ user: "Fix it", assistant: "Let me read first..." }])
      .tools(["read_file", "write_file"])
      .mcpTools(["mcp:filesystem/*"])
      .canDelegateTo(["math"], { maxDepth: 2 })
      .permissions({ "write_file": "hitl", "read_file": "allow" })
      .maxConcurrency(3)
      .build();

    expect(def.rules).toEqual(["Always read before modifying.", "Be concise."]);
    expect(def.examples).toHaveLength(1);
    expect(def.toolRefs).toEqual(["read_file", "write_file", "mcp:filesystem/*"]);
    expect(def.delegationRules).toEqual({ targets: ["math"], maxDepth: 2 });
    expect(def.permissions).toEqual({ "write_file": "hitl", "read_file": "allow" });
    expect(def.maxConcurrency).toBe(3);
  });

  test("build() throws if id is empty", () => {
    expect(() => defineAgent("").build()).toThrow("id");
  });

  test("build() throws if model is not set", () => {
    expect(() =>
      defineAgent("test")
        .name("Test")
        .role("Test role")
        .build()
    ).toThrow("model");
  });

  test("build() throws if neither systemPrompt nor role is set", () => {
    expect(() =>
      defineAgent("test")
        .name("Test")
        .model("openrouter", "x")
        .build()
    ).toThrow();
  });

  test("createAgent produces an Agent-compatible factory", () => {
    const def = defineAgent("code")
      .name("Code")
      .role("Code specialist.")
      .model("openrouter", "google/gemini-3.1-flash-lite-preview")
      .systemPrompt("You code.")
      .build();

    expect(typeof def.createAgent).toBe("function");
  });

  test("capabilities default to empty array", () => {
    const def = defineAgent("test")
      .name("Test")
      .role("Test.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .build();

    expect(def.capabilities).toEqual([]);
  });

  test("capabilities can be set", () => {
    const def = defineAgent("test")
      .name("Test")
      .role("Test.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .capabilities(["a", "b"])
      .build();

    expect(def.capabilities).toEqual(["a", "b"]);
  });

  test("schedule sets scheduleConfig on definition", () => {
    const def = defineAgent("cron-agent")
      .name("Cron Agent")
      .role("Runs on schedule.")
      .model("openrouter", "x")
      .systemPrompt("You run periodically.")
      .schedule({ type: "cron", cron: "*/5 * * * *" }, "health check")
      .build();

    expect(def.scheduleConfig).toEqual({
      schedule: { type: "cron", cron: "*/5 * * * *" },
      task: "health check",
    });
  });

  test("scheduleConfig defaults to undefined", () => {
    const def = defineAgent("no-sched")
      .name("No Schedule")
      .role("No schedule.")
      .model("openrouter", "x")
      .systemPrompt("You test.")
      .build();

    expect(def.scheduleConfig).toBeUndefined();
  });

  test("skills config can be set", () => {
    const def = defineAgent("skills-agent")
      .name("Skills Agent")
      .role("Uses local skills.")
      .model("openrouter", "x")
      .systemPrompt("You can use skills.")
      .skills({
        enabled: true,
        roots: ["skills"],
        maxSkillsPerTurn: 2,
      })
      .build();

    expect(def.skillsConfig).toBeDefined();
    expect(def.skillsConfig?.enabled).toBe(true);
    expect(def.skillsConfig?.roots).toEqual(["skills"]);
    expect(def.skillsConfig?.maxSkillsPerTurn).toBe(2);
  });
});
