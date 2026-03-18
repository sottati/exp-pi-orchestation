import { defineAgent, type AgentDefinition } from "./agent-builder";

export const ORCHESTRATOR_ID = "orchestrator" as const;

export function createAgentDefinitions(): AgentDefinition[] {
  const orchestrator = defineAgent(ORCHESTRATOR_ID)
    .name("Orchestrator")
    .role("Routes and delegates tasks to specialists.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are an orchestrator agent.",
      "Use list_agents to discover available specialists.",
      "Use delegate to send tasks to specialists.",
      "Then poll with get_chat_status/get_chat_result to get results.",
      "After tool results, produce a direct final answer for the user.",
      "Be concise by default.",
    ].join(" "))
    .capabilities(["routing", "delegation"])
    .tools([])
    .maxConcurrency(Infinity)
    .build();

  const code = defineAgent("code")
    .name("Code Specialist")
    .role("Creates focused code snippets.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a coding specialist. Return concise, practical answers. Prefer short code snippets and include only essential explanation."
    )
    .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
    .maxConcurrency(1)
    .build();

  const math = defineAgent("math")
    .name("Math Specialist")
    .role("Solves arithmetic operations.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a math specialist. Solve arithmetic tasks clearly and accurately. Return the final numeric result in one short sentence. Show steps only if the user asks."
    )
    .capabilities(["add", "subtract", "multiply", "divide"])
    .maxConcurrency(1)
    .build();

  return [orchestrator, code, math];
}

// Deprecated — kept for backward compatibility until runtime migration (Task 15)
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { SpecialistRegistry } from "./tools";

/** @deprecated Use createAgentDefinitions() instead. */
export function createSpecialistRegistry(): SpecialistRegistry {
  const defs = createAgentDefinitions();
  const registry: SpecialistRegistry = {};
  for (const def of defs) {
    if (def.id === ORCHESTRATOR_ID) continue;
    registry[def.id] = {
      id: def.id,
      name: def.name,
      role: def.role,
      capabilities: def.capabilities,
      maxConcurrency: def.maxConcurrency,
      createAgent: () => def.createAgent([], def.systemPrompt),
    };
  }
  return registry;
}

/** @deprecated Use createAgentDefinitions() instead. */
export function createOrchestratorAgent(tools: AgentTool<any>[] = []) {
  const defs = createAgentDefinitions();
  const orch = defs.find(d => d.id === ORCHESTRATOR_ID)!;
  return orch.createAgent(tools, orch.systemPrompt);
}
