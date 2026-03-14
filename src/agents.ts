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
            `Model init failed (${provider}/${modelId}). Set PI_MODEL_PROVIDER/PI_MODEL_ID. ${errorMessage(err)}`
        );
    }
    _modelCache.set(key, model);
    return model;
}

const QWEN_CODER = { provider: "openrouter", modelId: "qwen/qwen3-coder:free" };
const NVIDIA_NEMOTRON = { provider: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free" };

function createCodeSpecialistAgent() {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a coding specialist. Return concise, practical answers. Prefer short code snippets and include only essential explanation.",
            model: getModelCached(QWEN_CODER.provider, QWEN_CODER.modelId),
            tools: [],
            messages: [],
        },
    });
}

function createMathSpecialistAgent() {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a math specialist. Solve arithmetic tasks clearly and accurately. You can add, subtract, multiply, and divide.",
            model: getModelCached(NVIDIA_NEMOTRON.provider, NVIDIA_NEMOTRON.modelId),
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
            agent: createCodeSpecialistAgent(),
        },
        math: {
            id: "math",
            name: "Math Specialist",
            role: "Solves arithmetic operations.",
            capabilities: ["add", "subtract", "multiply", "divide"],
            inputHint: "Include numbers and operation.",
            maxConcurrency: 1,
            agent: createMathSpecialistAgent(),
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
                "Then poll with get_chat_status/get_chat_result to get results.",
                "After tool results, produce a direct final answer for the user.",
            ].join(" "),
            model: getModelCached(QWEN_CODER.provider, QWEN_CODER.modelId),
            tools,
            messages: [],
        },
    });
}
