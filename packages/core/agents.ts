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

function createCodeSpecialistAgent(tools: AgentTool<any>[] = []) {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a coding specialist. Return concise, practical answers with implementation-ready details. Prefer short code snippets plus only the essential explanation. When asked for terminal flows, default to Bun commands. You are reactive: never start outbound conversations by yourself. Only call report_to_orchestrator when the user explicitly asks you to report.",
            model: modelFor("code"),
            tools,
            messages: [],
        },
    });
}

function createMathSpecialistAgent(tools: AgentTool<any>[] = []) {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a math specialist. Solve arithmetic tasks clearly and accurately. Return the final numeric result in one short sentence. Show steps only if the user asks. If a numeric check is requested, prioritize correctness over verbosity. You are reactive: never start outbound conversations by yourself. Only call report_to_orchestrator when the user explicitly asks you to report.",
            model: modelFor("math"),
            tools,
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
                "When delegation is required, always report chatId and current status in your reasoning before final answer.",
                "If a chat is still active or waiting, return a progress update and keep the response actionable.",
                "Use run_bash only for terminal checks/commands the user asks for.",
                "Prefer delegate for specialist work (math/code), not run_bash.",
                "After tool results, produce a direct final answer for the user.",
                "When the user asks to validate tools/orchestration, run a short end-to-end check with delegate + status/result tools.",
                "Be concise by default.",
            ].join(" "),
            model: modelFor("orchestrator"),
            tools,
            messages: [],
        },
    });
}
