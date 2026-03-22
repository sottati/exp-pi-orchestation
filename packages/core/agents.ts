import { defineAgent, type AgentDefinition } from "./agent-builder";
import type { CredentialStore } from "./credential-store";
import { createExplorerToolEntries } from "./explorer-tools";

export const ORCHESTRATOR_ID = "orchestrator" as const;

export function createAgentDefinitions(opts?: {
  credentialStore?: CredentialStore;
}): AgentDefinition[] {
  const orchestrator = defineAgent(ORCHESTRATOR_ID)
    .name("Orchestrator")
    .role("Routes and delegates tasks to specialists.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are an orchestrator agent.",
      "Use list_agents to discover available specialists.",
      "Use delegate to send tasks to specialists.",
      "Then poll with get_chat_status/get_chat_result to get results.",
      "You can schedule recurring or delayed tasks using schedule_task (cron, one-time, or delayed).",
      "Use list_scheduled_jobs to see active jobs, cancel_scheduled_job to remove them.",
      "The explorer specialist can browse the web, search, and interact with pages.",
      "After tool results, produce a direct final answer for the user.",
      "Be concise by default.",
    ].join(" "))
    .capabilities(["routing", "delegation", "scheduling"])
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

  const explorerTools = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });

  const explorer = defineAgent("explorer")
    .name("Web Explorer")
    .role("Retrieves information from the web via browsing and scraping.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a web explorer specialist. You retrieve information from the web.",
      "",
      "You have three tools:",
      "- browse_url: Fetch and extract readable content from a URL. Returns markdown.",
      "- search_web: Search the web for a query. Returns titles, URLs, and snippets.",
      "- interact_page: Navigate to a URL and perform actions (click, fill, select, wait).",
      "  Supports followUpUrls to navigate after actions (e.g., login then browse).",
      "  Credentials can be auto-injected using {{credential:username}} and {{credential:password}} placeholders.",
      "",
      "Guidelines:",
      "- Return extracted content relevant to the task. Trim irrelevant navigation, ads, footers.",
      "- For search tasks, return the top results with URLs so the caller can follow up.",
      "- If a page fails to load or is blocked, report the error clearly — do not retry.",
      "- Do not summarize or editorialize unless the task explicitly asks for analysis.",
      "- Do not perform purchases, account creation, or irreversible actions.",
      "- Be concise. Prefer structured output (lists, key-value) over prose.",
    ].join("\n"))
    .capabilities(["browse", "search", "interact", "extract"])
    .localToolEntries(explorerTools)
    .permissions({ "interact_page": "hitl" })
    .maxConcurrency(1)
    .build();

  return [orchestrator, code, math, explorer];
}

// Deprecated — kept for backward compatibility until runtime migration (Task 15)
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { SpecialistRegistry } from "./tools";

/** @deprecated Use createAgentDefinitions() instead. */
export function createSpecialistRegistry(opts?: {
  credentialStore?: CredentialStore;
}): SpecialistRegistry {
  const defs = createAgentDefinitions(opts);
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
export function createOrchestratorAgent(tools: AgentTool<any>[] = [], opts?: {
  credentialStore?: CredentialStore;
}) {
  const defs = createAgentDefinitions(opts);
  const orch = defs.find(d => d.id === ORCHESTRATOR_ID)!;
  return orch.createAgent(tools, orch.systemPrompt);
}
