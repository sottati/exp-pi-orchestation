import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { MemoryClient } from "./memory-client";

export function createMemoryToolEntries(client: MemoryClient): ToolEntry[] {
  const memSave: ToolEntry = {
    name: "mem_save",
    source: "local",
    description: "Save a relevant observation or learning to long-term memory for future sessions.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for this memory" }),
      type: Type.Union(
        [
          Type.Literal("decision"),
          Type.Literal("preference"),
          Type.Literal("pattern"),
          Type.Literal("bug"),
          Type.Literal("architecture"),
          Type.Literal("conversation_summary"),
        ],
        { description: "Category of memory" },
      ),
      what: Type.String({ description: "What happened or was decided" }),
      why: Type.String({ description: "Why it matters" }),
      where: Type.Optional(
        Type.String({ description: "File path, URL, or component name (optional)" }),
      ),
      learned: Type.String({ description: "What should be remembered for future sessions" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const { title, type, what, why, where: where_, learned } = params as {
        title: string;
        type: "decision" | "preference" | "pattern" | "bug" | "architecture" | "conversation_summary";
        what: string;
        why: string;
        where?: string;
        learned: string;
      };

      const content = `What: ${what}\nWhy: ${why}${where_ ? `\nWhere: ${where_}` : ""}\nLearned: ${learned}`;
      const id = await client.save({ type, title, content });

      if (id !== undefined) {
        return { content: [{ type: "text" as const, text: `Memory saved (id: ${id})` }], details: undefined };
      }
      return { content: [{ type: "text" as const, text: "Memory saved (engram unavailable)" }], details: undefined };
    },
  };

  const memGet: ToolEntry = {
    name: "mem_get",
    source: "local",
    description: "Retrieve relevant memories from long-term storage to inform current work.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      limit: Type.Optional(
        Type.Integer({
          description: "Max results",
          minimum: 1,
          maximum: 20,
          default: 5,
        }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = params.query as string;
      const limit = (params.limit as number | undefined) ?? 5;

      const results = await client.search(query, limit);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found." }], details: undefined };
      }

      const formatted = results
        .map((r, i) => `[${i + 1}] ${r.title} (${r.type})\n${r.content}`)
        .join("\n\n");

      return { content: [{ type: "text" as const, text: formatted }], details: undefined };
    },
  };

  return [memSave, memGet];
}
