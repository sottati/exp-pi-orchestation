import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolEntry, ToolExecuteFn } from "./tool-registry";
import type { Permission } from "./contracts";

export class McpDisconnectedError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP server '${serverName}' is disconnected.`);
    this.name = "McpDisconnectedError";
    this.serverName = serverName;
  }
}

export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; transport: "http"; url: string; headers?: Record<string, string> };

export function parseMcpToolName(serverName: string, toolName: string): string {
  return `mcp:${serverName}/${toolName}`;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Convert MCP tool descriptors into ToolEntry objects. */
export function mcpToolsToEntries(
  serverName: string,
  tools: McpToolDescriptor[],
  callTool: (toolName: string, params: Record<string, unknown>) => Promise<string>,
  defaultPermission: Permission = "allow",
): ToolEntry[] {
  return tools.map((t) => {
    const qualifiedName = parseMcpToolName(serverName, t.name);
    const parameters: TSchema = t.inputSchema
      ? Type.Unsafe(t.inputSchema)
      : Type.Object({});

    const execute: ToolExecuteFn = async (_toolCallId, params) => {
      const result = await callTool(t.name, params);
      return { content: [{ type: "text", text: result }] };
    };

    return {
      name: qualifiedName,
      source: "mcp" as const,
      mcpServer: serverName,
      description: t.description ?? `MCP tool: ${t.name}`,
      parameters,
      execute,
      defaultPermission,
      available: true,
    };
  });
}

export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const MAX_RECONNECT_ATTEMPTS = 5;
