import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Permission } from "./contracts";
import type { AgentHooks } from "./agent-builder";
import { errorMessage } from "./errors";

export interface HITLRequest {
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  reason: string;
  timeout: number;
}

export interface HITLResponse {
  approved: boolean;
  modifiedParams?: Record<string, unknown>;
}

export type HITLHandler = (request: HITLRequest) => Promise<HITLResponse>;

export interface WrapToolOptions {
  permission: Permission;
  hitlHandler: HITLHandler;
  hooks?: AgentHooks;
  agentId: string;
  hitlTimeout?: number;
  onHitlStart?: (request: HITLRequest) => Promise<void> | void;
  onHitlEnd?: (request: HITLRequest) => Promise<void> | void;
  tracePermission: (info: { toolName: string; permission: Permission; resolved: string }) => Promise<void>;
}

export function resolvePermission(
  runtimeOverride: Permission | undefined,
  agentPermissions: Record<string, Permission>,
  toolName: string,
  defaultPermission: Permission,
): Permission {
  if (runtimeOverride) return runtimeOverride;

  // Check exact match first
  if (agentPermissions[toolName]) return agentPermissions[toolName];

  // Check glob patterns in agent permissions
  for (const [pattern, perm] of Object.entries(agentPermissions)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (toolName.startsWith(prefix)) return perm;
    }
  }

  return defaultPermission || "deny";
}

export function wrapTool(
  tool: AgentTool<any>,
  options: WrapToolOptions,
): AgentTool<any> {
  const {
    permission,
    hitlHandler,
    hooks,
    agentId,
    hitlTimeout = 60_000,
    onHitlStart,
    onHitlEnd,
    tracePermission,
  } = options;

  return {
    ...tool,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      // 1. Permission check
      await tracePermission({ toolName: tool.name, permission, resolved: permission });

      if (permission === "deny") {
        return {
          content: [{ type: "text", text: `Tool '${tool.name}' is denied for agent '${agentId}'.` }],
          details: {},
        };
      }

      let finalParams = params;

      // 2. HITL prompt if needed
      if (permission === "hitl") {
        const request: HITLRequest = {
          agentId,
          toolName: tool.name,
          params,
          reason: `Agent '${agentId}' wants to use '${tool.name}'.`,
          timeout: hitlTimeout,
        };

        let response: HITLResponse;
        try {
          await onHitlStart?.(request);
          response = await Promise.race([
            hitlHandler(request),
            new Promise<HITLResponse>((_, reject) =>
              setTimeout(() => reject(new Error("HITL_TIMEOUT")), hitlTimeout)
            ),
          ]);
        } catch (err) {
          if (err instanceof Error && err.message === "HITL_TIMEOUT") {
            return {
              content: [{ type: "text", text: `Approval timed out, tool '${tool.name}' denied.` }],
              details: {},
            };
          }
          throw err;
        } finally {
          await onHitlEnd?.(request);
        }

        if (!response.approved) {
          return {
            content: [{ type: "text", text: `Tool '${tool.name}' denied by human.` }],
            details: {},
          };
        }

        if (response.modifiedParams) {
          finalParams = response.modifiedParams;
        }
      }

      // 3. beforeTool hook
      if (hooks?.beforeTool) {
        finalParams = await hooks.beforeTool(tool.name, finalParams, { agentId });
      }

      // 4. Execute
      let result;
      try {
        result = await tool.execute(toolCallId, finalParams);
      } catch (err) {
        console.error(
          `[tool-error] agent=${agentId} tool=${tool.name} call=${toolCallId}: ${errorMessage(err)}`,
        );
        throw err;
      }

      // 5. afterTool hook
      if (hooks?.afterTool) {
        result = await hooks.afterTool(tool.name, result, { agentId }) as typeof result;
      }

      return result;
    },
  };
}
