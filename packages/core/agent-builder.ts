import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { errorMessage } from "./errors";
import type { Permission, ScheduledJob } from "./contracts";
import type { ToolEntry } from "./tool-registry";

export interface AgentSkillsConfig {
  enabled?: boolean;
  roots?: string[];
  maxSkillsPerTurn?: number;
  maxCharsPerSkill?: number;
  maxTotalChars?: number;
}

export interface AgentModelConfig {
  provider: string;
  modelId: string;
}

export interface AgentHooks {
  beforeTool?: (
    toolName: string,
    params: Record<string, unknown>,
    ctx: { agentId: string }
  ) => Promise<Record<string, unknown>>;
  afterTool?: (
    toolName: string,
    result: unknown,
    ctx: { agentId: string }
  ) => Promise<unknown>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  modelConfig: AgentModelConfig;
  systemPrompt: string;
  rules: string[];
  examples: Array<{ user: string; assistant: string }>;
  toolRefs: string[];
  localTools?: ToolEntry[];
  delegationRules: { targets: string[]; maxDepth: number } | null;
  skillsConfig?: AgentSkillsConfig;
  permissions: Record<string, Permission>;
  hooks: AgentHooks;
  maxConcurrency: number;
  scheduleConfig?: { schedule: ScheduledJob["schedule"]; task: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  createAgent: (resolvedTools: AgentTool<any>[], compiledPrompt: string) => Agent;
}

class AgentBuilder {
  private _id: string;
  private _name: string = "";
  private _role: string = "";
  private _capabilities: string[] = [];
  private _provider: string | null = null;
  private _modelId: string | null = null;
  private _systemPrompt: string = "";
  private _rules: string[] = [];
  private _examples: Array<{ user: string; assistant: string }> = [];
  private _toolRefs: string[] = [];
  private _mcpToolRefs: string[] = [];
  private _localTools: ToolEntry[] = [];
  private _delegationRules: { targets: string[]; maxDepth: number } | null = null;
  private _skillsConfig?: AgentSkillsConfig;
  private _permissions: Record<string, Permission> = {};
  private _hooks: AgentHooks = {};
  private _maxConcurrency: number = 1;
  private _scheduleConfig?: { schedule: ScheduledJob["schedule"]; task: string };
  private _thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

  constructor(id: string) {
    this._id = id;
  }

  name(value: string): this {
    this._name = value;
    return this;
  }

  role(value: string): this {
    this._role = value;
    return this;
  }

  capabilities(value: string[]): this {
    this._capabilities = value;
    return this;
  }

  model(provider: string, modelId: string): this {
    this._provider = provider;
    this._modelId = modelId;
    return this;
  }

  systemPrompt(value: string): this {
    this._systemPrompt = value;
    return this;
  }

  rules(value: string[]): this {
    this._rules = value;
    return this;
  }

  examples(value: Array<{ user: string; assistant: string }>): this {
    this._examples = value;
    return this;
  }

  tools(refs: string[]): this {
    this._toolRefs = refs;
    return this;
  }

  mcpTools(refs: string[]): this {
    this._mcpToolRefs = refs;
    return this;
  }

  localToolEntries(entries: ToolEntry[]): this {
    this._localTools = entries;
    return this;
  }

  canDelegateTo(targets: string[], opts: { maxDepth?: number } = {}): this {
    this._delegationRules = { targets, maxDepth: opts.maxDepth ?? 1 };
    return this;
  }

  skills(value: AgentSkillsConfig): this {
    this._skillsConfig = value;
    return this;
  }

  permissions(value: Record<string, Permission>): this {
    this._permissions = value;
    return this;
  }

  hooks(value: AgentHooks): this {
    this._hooks = value;
    return this;
  }

  maxConcurrency(value: number): this {
    this._maxConcurrency = value;
    return this;
  }

  schedule(schedule: ScheduledJob["schedule"], task: string): this {
    this._scheduleConfig = { schedule, task };
    return this;
  }

  thinkingLevel(value: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): this {
    this._thinkingLevel = value;
    return this;
  }

  build(): AgentDefinition {
    if (!this._id) {
      throw new Error("AgentDefinition requires a non-empty id");
    }
    if (this._provider === null || this._modelId === null) {
      throw new Error("AgentDefinition requires a model — call .model(provider, modelId)");
    }
    if (!this._role && !this._systemPrompt) {
      throw new Error("AgentDefinition requires either a role or systemPrompt");
    }

    const provider = this._provider;
    const modelId = this._modelId;
    const systemPrompt = this._systemPrompt || this._role;

    const createAgent = (resolvedTools: AgentTool<any>[], compiledPrompt: string): Agent => {
      let model: ReturnType<typeof getModel>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model = getModel(provider as any, modelId as any);
      } catch (err) {
        throw new Error(
          `Model init failed (${provider}/${modelId}): ${errorMessage(err)}`
        );
      }
      return new Agent({
        initialState: {
          systemPrompt: compiledPrompt,
          model,
          thinkingLevel: this._thinkingLevel ?? "off",
          tools: resolvedTools,
          messages: [],
        },
      });
    };

    const def: AgentDefinition = {
      id: this._id,
      name: this._name,
      role: this._role,
      capabilities: this._capabilities,
      modelConfig: { provider, modelId },
      systemPrompt,
      rules: this._rules,
      examples: this._examples,
      toolRefs: [...this._toolRefs, ...this._mcpToolRefs],
      localTools: this._localTools.length > 0 ? this._localTools : undefined,
      delegationRules: this._delegationRules,
      skillsConfig: this._skillsConfig,
      permissions: this._permissions,
      hooks: this._hooks,
      maxConcurrency: this._maxConcurrency,
      scheduleConfig: this._scheduleConfig,
      thinkingLevel: this._thinkingLevel,
      createAgent,
    };

    return def;
  }
}

export function defineAgent(id: string): AgentBuilder {
  return new AgentBuilder(id);
}
