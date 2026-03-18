import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentChat, RunContext } from "./contracts";

const delegateParams = Type.Object({
  agentId: Type.String({ description: "Target specialist id." }),
  task: Type.String({ description: "Task to delegate." }),
  context: Type.Optional(Type.String({ description: "Optional extra context." })),
});

type DelegateParams = Static<typeof delegateParams>;

export interface DelegationDeps {
  createDelegation: (input: { agentId: string; task: string; context?: string; runContext?: RunContext }) => AgentChat;
  getChat: (chatId: string) => AgentChat | undefined;
  closeChat: (chatId: string) => AgentChat | undefined;
  getQueuePosition: (chatId: string) => number | undefined;
  traceToolEvent: (input: { type: string; status: string; runContext?: RunContext; toolName: string; toolCallId: string; details?: Record<string, unknown> }) => Promise<void>;
  getRunContext: () => RunContext;
}

export interface RestrictedDelegateOptions {
  fromAgentId: string;
  allowedTargets: string[];
  maxDepth: number;
  currentDepth: number;
  delegationChain: string[];
  deps: DelegationDeps;
}

export function createRestrictedDelegateTool(options: RestrictedDelegateOptions): AgentTool<any> {
  const { fromAgentId, allowedTargets, maxDepth, currentDepth, delegationChain, deps } = options;

  return {
    name: "delegate",
    label: "Delegate task to specialist",
    description: `Delegate a task to a specialist. Allowed targets: ${allowedTargets.join(", ")}.`,
    parameters: delegateParams,
    execute: async (toolCallId: string, params: DelegateParams) => {
      // 1. Check depth
      if (currentDepth >= maxDepth) {
        return {
          content: [{ type: "text" as const, text: `Cannot delegate: max depth ${maxDepth} reached.` }],
          details: {},
        };
      }

      // 2. Check target whitelist
      if (!allowedTargets.includes(params.agentId)) {
        return {
          content: [{ type: "text" as const, text: `Agent '${params.agentId}' is not allowed. Allowed: ${allowedTargets.join(", ")}.` }],
          details: {},
        };
      }

      // 3. Check cycle
      if (delegationChain.includes(params.agentId)) {
        return {
          content: [{ type: "text" as const, text: `Delegation cycle detected: ${[...delegationChain, params.agentId].join(" -> ")}.` }],
          details: {},
        };
      }

      // 4. Delegate
      const runContext = deps.getRunContext();
      const chat = deps.createDelegation({
        agentId: params.agentId,
        task: params.task,
        context: params.context,
        runContext: {
          ...runContext,
          delegationDepth: currentDepth + 1,
          delegationChain: [...delegationChain, fromAgentId],
        },
      });

      return {
        content: [{ type: "text", text: `Delegated to ${params.agentId}. chatId=${chat.chatId}.` }],
        details: { chatId: chat.chatId, fromAgentId, targetAgentId: params.agentId },
      };
    },
  };
}
