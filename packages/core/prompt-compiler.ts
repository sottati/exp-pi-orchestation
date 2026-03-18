import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentDefinition } from "./agent-builder";

const MAX_TOOL_SECTION_CHARS = 4000;

function compileToolSection(tools: AgentTool<any>[]): string {
  if (tools.length === 0) return "";

  const lines: string[] = ["## Available Tools", ""];
  let totalChars = 0;

  for (const tool of tools) {
    const line = `- **${tool.name}**: ${tool.description}`;
    if (totalChars + line.length > MAX_TOOL_SECTION_CHARS) {
      lines.push(`- ... and ${tools.length - lines.length + 2} more tools.`);
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }

  return lines.join("\n");
}

function compileDelegationSection(rules: { targets: string[]; maxDepth: number }): string {
  const targetList = rules.targets.join(", ");
  return [
    "## Delegation",
    "",
    `You can delegate tasks to these specialists: ${targetList}.`,
    `Use the delegate tool. Max delegation depth: ${rules.maxDepth}.`,
  ].join("\n");
}

function compileRulesSection(rules: string[]): string {
  if (rules.length === 0) return "";
  return ["## Rules", "", ...rules.map((r) => `- ${r}`)].join("\n");
}

function compileExamplesSection(examples: Array<{ user: string; assistant: string }>): string {
  if (examples.length === 0) return "";
  const parts = examples.map(
    (e) => `User: ${e.user}\nAssistant: ${e.assistant}`
  );
  return ["## Examples", "", parts.join("\n---\n")].join("\n");
}

export function compileSystemPrompt(
  def: AgentDefinition,
  resolvedTools: AgentTool<any>[],
): string {
  const sections: string[] = [def.systemPrompt];

  const toolSection = compileToolSection(resolvedTools);
  if (toolSection) sections.push(toolSection);

  if (def.delegationRules) {
    sections.push(compileDelegationSection(def.delegationRules));
  }

  const rulesSection = compileRulesSection(def.rules);
  if (rulesSection) sections.push(rulesSection);

  const examplesSection = compileExamplesSection(def.examples);
  if (examplesSection) sections.push(examplesSection);

  return sections.join("\n\n");
}
