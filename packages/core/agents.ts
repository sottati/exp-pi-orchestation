import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { errorMessage } from "./errors";
import type { SpecialistRegistry } from "./tools";

export const ORCHESTRATOR_ID = "orchestrator" as const;

const _modelCache = new Map<string, ReturnType<typeof getModel>>();

function getModelCached(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    let model = _modelCache.get(key);
    if (model) return model;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model = getModel(provider as any, modelId as any);
    } catch (err) {
        throw new Error(
            `Model init failed (${provider}/${modelId}). Update AGENT_MODEL_CONFIG in packages/core/agents.ts. ${errorMessage(err)}`
        );
    }
    _modelCache.set(key, model);
    return model;
}

type ManagedAgentId = "orchestrator" | "code" | "math";

interface AgentModelConfig {
    provider: string;
    modelId: string;
}

const AGENT_MODEL_CONFIG: Record<ManagedAgentId, AgentModelConfig> = {
    orchestrator: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
    code: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
    math: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
};

function modelFor(agentId: ManagedAgentId) {
    const config = AGENT_MODEL_CONFIG[agentId];
    return getModelCached(config.provider, config.modelId);
}

function createCodeSpecialistAgent() {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a coding specialist. Return concise, practical answers. Prefer short code snippets and include only essential explanation.",
            model: modelFor("code"),
            tools: [],
            messages: [],
        },
    });
}

function createMathSpecialistAgent() {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a math specialist. Solve arithmetic tasks clearly and accurately. Return the final numeric result in one short sentence. Show steps only if the user asks.",
            model: modelFor("math"),
            tools: [],
            messages: [],
        },
    });
}

export function createSpecialistRegistry(): SpecialistRegistry {
    return {
        code: {
            id: "code",
            name: "Code Specialist",
            role: "Creates focused code snippets.",
            capabilities: ["code-snippet", "small-refactor", "bug-fix-hint"],
            inputHint: "Include language and constraints.",
            maxConcurrency: 1,
            createAgent: createCodeSpecialistAgent,
        },
        math: {
            id: "math",
            name: "Math Specialist",
            role: "Solves arithmetic operations.",
            capabilities: ["add", "subtract", "multiply", "divide"],
            inputHint: "Include numbers and operation.",
            maxConcurrency: 1,
            createAgent: createMathSpecialistAgent,
        },
    };
}

export function createOrchestratorAgent(tools: AgentTool<any>[] = []) {
    return new Agent({
        initialState: {
            systemPrompt: [
                "You are an orchestrator agent.",
                "Use list_agents to discover available specialists.",
                "Use delegate to send tasks to specialists.",
                "If chat is already active, use follow_up_chat to continue same chatId.",
                "Then poll with get_chat_status/get_chat_result to get results.",
                "After tool results, produce a direct final answer for the user.",
                "Be concise by default.",
            ].join(" "),
            model: modelFor("orchestrator"),
            tools,
            messages: [],
        },
    });
}
