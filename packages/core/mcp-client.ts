import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolEntry, ToolExecuteFn, McpConnector } from "./tool-registry";
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
      return { content: [{ type: "text" as const, text: result }], details: {} };
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

/** Implements McpConnector over a stdio child process using MCP JSON-RPC protocol. */
export class StdioMcpConnector implements McpConnector {
  private process: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private initialized = false;

  constructor(private readonly config: Extract<McpServerConfig, { transport: "stdio" }>) {}

  private async start(): Promise<void> {
    if (this.initialized) return;

    const [cmd, ...defaultArgs] = this.config.command.split(" ");
    const args = [...defaultArgs, ...(this.config.args ?? [])];

    await new Promise<void>((resolve, reject) => {
      this.process = spawn(cmd!, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(this.config.env ?? {}) },
      });

      this.process.on("error", (err) => {
        if (!this.initialized) reject(err);
      });

      this.process.stdout!.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.onLine(line);
        }
      });

      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-agent", version: "1.0.0" },
      }).then(() => {
        this.sendNotification("notifications/initialized", {});
        this.initialized = true;
        resolve();
      }).catch(reject);
    });
  }

  private onLine(line: string): void {
    try {
      const msg = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { message: string; code?: number };
      };
      if (msg.id == null) return; // server notification, ignore
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`MCP error ${msg.error.code ?? ""}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    } catch {
      // malformed line — skip
    }
  }

  private sendNotification(method: string, params: unknown): void {
    this.process?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out (id=${id}, method=${method})`));
        }
      }, 30_000);
    });
  }

  async discover(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    await this.start();
    const result = await this.sendRequest("tools/list", {}) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return result.tools ?? [];
  }

  async callTool(toolName: string, params: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.start();
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: params,
    }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool execution failed");
    return text;
  }

  async disconnect(): Promise<void> {
    this.initialized = false;
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    for (const [, { reject }] of this.pending) {
      reject(new Error("MCP connector disconnected"));
    }
    this.pending.clear();
  }
}

/** Factory: creates the appropriate McpConnector for a given config. */
export function createMcpConnector(config: McpServerConfig): McpConnector {
  if (config.transport === "stdio") return new StdioMcpConnector(config);
  throw new Error(`MCP transport '${(config as McpServerConfig).transport}' not yet implemented`);
}
