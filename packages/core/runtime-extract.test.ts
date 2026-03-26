import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractLastAssistantText } from "./runtime";

describe("extractLastAssistantText", () => {
  test("skips empty final assistant and falls back to completed get_chat_result", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "delegate", arguments: { agentId: "secretary" } }],
        stopReason: "toolUse",
      } as any,
      {
        role: "toolResult",
        toolName: "get_chat_result",
        content: [{ type: "text", text: "No tengo contactos guardados." }],
        details: {
          status: "closed",
          closeReason: "completed",
          result: "No tengo contactos guardados.",
        },
      } as any,
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
      } as any,
    ];

    expect(extractLastAssistantText(messages)).toBe("No tengo contactos guardados.");
  });

  test("strips leaked thought prefix from final assistant text", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "thought:La secretaria confirmó el guardado." }],
        stopReason: "stop",
      } as any,
    ];

    expect(extractLastAssistantText(messages)).toBe("La secretaria confirmó el guardado.");
  });

  test("continues searching when latest assistant has no visible text", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Respuesta final útil." }],
        stopReason: "stop",
      } as any,
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
      } as any,
    ];

    expect(extractLastAssistantText(messages)).toBe("Respuesta final útil.");
  });
});
