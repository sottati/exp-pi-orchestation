import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { Permission } from "./contracts";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<AgentToolResult<any>>;

export interface ToolEntry {
  name: string;
  source: "local" | "mcp";
  mcpServer?: string;
  description: string;
  parameters: TSchema;
  execute: ToolExecuteFn;
  defaultPermission: Permission;
  available: boolean;
}

function matchesGlob(pattern: string, name: string): boolean {
  if (!pattern.endsWith("*")) return pattern === name;
  const prefix = pattern.slice(0, -1);
  return name.startsWith(prefix);
}

export interface McpConnector {
  discover: () => Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  callTool: (toolName: string, params: Record<string, unknown>) => Promise<string>;
  disconnect: () => Promise<void>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly mcpConnectors = new Map<string, McpConnector>();

  register(tool: ToolEntry): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  list(): ToolEntry[] {
    return [...this.tools.values()];
  }

  resolve(refs: string[]): ToolEntry[] {
    const seen = new Set<string>();
    const result: ToolEntry[] = [];

    for (const ref of refs) {
      if (ref.includes("*")) {
        for (const tool of this.tools.values()) {
          if (!tool.available) continue;
          if (matchesGlob(ref, tool.name) && !seen.has(tool.name)) {
            seen.add(tool.name);
            result.push(tool);
          }
        }
      } else {
        const tool = this.tools.get(ref);
        if (tool && tool.available && !seen.has(tool.name)) {
          seen.add(tool.name);
          result.push(tool);
        }
      }
    }

    return result;
  }

  markAvailable(name: string, available: boolean): void {
    const tool = this.tools.get(name);
    if (tool) tool.available = available;
  }

  markMcpAvailable(serverName: string, available: boolean): void {
    for (const tool of this.tools.values()) {
      if (tool.source === "mcp" && tool.mcpServer === serverName) {
        tool.available = available;
      }
    }
  }

  removeMcpTools(serverName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.source === "mcp" && tool.mcpServer === serverName) {
        this.tools.delete(name);
      }
    }
  }

  async connectMcp(serverName: string, connector: McpConnector): Promise<void> {
    const descriptors = await connector.discover();
    this.mcpConnectors.set(serverName, connector);
    for (const desc of descriptors) {
      const qualifiedName = `mcp:${serverName}/${desc.name}`;
      const parameters: TSchema = desc.inputSchema
        ? Type.Unsafe(desc.inputSchema)
        : Type.Object({});
      this.register({
        name: qualifiedName,
        source: "mcp",
        mcpServer: serverName,
        description: desc.description ?? `MCP tool: ${desc.name}`,
        parameters,
        execute: async (_toolCallId, params) => {
          const result = await connector.callTool(desc.name, params);
          return { content: [{ type: "text" as const, text: result }], details: {} };
        },
        defaultPermission: "allow",
        available: true,
      });
    }
  }

  async disconnectMcp(serverName: string): Promise<void> {
    const connector = this.mcpConnectors.get(serverName);
    if (connector) {
      await connector.disconnect();
      this.mcpConnectors.delete(serverName);
    }
    this.removeMcpTools(serverName);
  }
}
