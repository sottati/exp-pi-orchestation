import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { errorMessage } from "./errors";
import type { SpecialistRegistry } from "./tools";

export const ORCHESTRATOR_ID = "orchestrator" as const;

let _defaultModel: ReturnType<typeof getModel> | undefined;

function getDefaultModel() {
    if (_defaultModel) return _defaultModel;
    const provider = process.env.PI_MODEL_PROVIDER ?? "openrouter";
    const modelId = process.env.PI_MODEL_ID ?? "openrouter/free";
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _defaultModel = getModel(provider as any, modelId as any);
    } catch (err) {
        throw new Error(
            `Model init failed (${provider}/${modelId}). Set PI_MODEL_PROVIDER/PI_MODEL_ID. ${errorMessage(err)}`
        );
    }
    return _defaultModel;
}

function createCodeSpecialistAgent() {
    return new Agent({
        initialState: {
            systemPrompt:
                "You are a coding specialist. Return concise, practical answers. Prefer short code snippets and include only essential explanation.",
            model: getDefaultModel(),
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
            model: getDefaultModel(),
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
            agent: createCodeSpecialistAgent(),
        },
        math: {
            id: "math",
            name: "Math Specialist",
            role: "Solves arithmetic operations.",
            capabilities: ["add", "subtract", "multiply", "divide"],
            inputHint: "Include numbers and operation.",
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
                "For short tasks, prefer delegate_task_sync.",
                "For long tasks, use delegate_task_async and then poll with get_task_status/get_task_result.",
                "After tool results, produce a direct final answer for the user.",
            ].join(" "),
            model: getDefaultModel(),
            tools,
            messages: [],
        },
    });
}