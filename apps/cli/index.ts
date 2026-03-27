import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { errorMessage } from "../../packages/core/errors";
import type { ChatInspection } from "../../packages/core/runtime";
import { MultiAgentRuntime } from "../../packages/core/runtime";
import type { HITLHandler, HITLRequest } from "../../packages/core/tool-middleware";

function cliError(err: unknown) { console.error("Error:", errorMessage(err)); }

type ChatTarget = string;
const VALID_SMOKES = ["math", "code", "orchestrator", "explorer", "writer", "debugger", "web-designer", "marketing"] as const;

function parseArgs(args: string[]) {
    const parsed: { sessionId: string; smoke?: (typeof VALID_SMOKES)[number] } = {
        sessionId: "default",
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if (arg === "--session" && next) {
            parsed.sessionId = next;
            i += 1;
        } else if (arg === "--smoke" && next) {
            const maybeSmoke = next;
            if (VALID_SMOKES.includes(maybeSmoke as (typeof VALID_SMOKES)[number])) {
                parsed.smoke = maybeSmoke as (typeof VALID_SMOKES)[number];
                i += 1;
            }
        }
    }

    return parsed;
}

function createCliHitlHandler(rl: ReturnType<typeof createInterface>): HITLHandler {
    return async (request: HITLRequest): Promise<{ approved: boolean; modifiedParams?: Record<string, unknown> }> => {
        console.log(`\n[HITL] Agent '${request.agentId}' wants to use '${request.toolName}'`);
        console.log(`  Params: ${JSON.stringify(request.params, null, 2)}`);
        const answer = await rl.question("  Approve? [y/N]: ");
        const approved = answer.trim().toLowerCase() === "y";
        return { approved };
    };
}

function printHelp() {
    console.log("\nComandos:");
    console.log("  /help                  muestra esta ayuda");
    console.log("  /agents                lista agentes disponibles");
    console.log("  /use <agentId>         cambia agente activo");
    console.log("  /chats                 lista chats activos + en cola");
    console.log("  /chat <chatId>         vista live de un chat (usa --json para raw)");
    console.log("  /close <chatId>        cierra un chat");
    console.log("  /scheduled [jobId]     lista scheduled jobs o inspecciona uno");
    console.log("  /cancel-job <jobId>    cancela un scheduled job");
    console.log("  /threads               lista threadIds");
    console.log("  /thread <threadId>     muestra mensajes del thread");
    console.log("  /traces [n]            muestra ultimos n eventos de traza (default 20)");
    console.log("  /smoke <name>          corre smoke (math|code|orchestrator|explorer|writer|debugger)");
    console.log("  /exit                  salir");
    console.log("  (aliases: /jobs=/chats, /job=/task=/chat, /cancel=/close)\n");
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") return item;
                if (
                    typeof item === "object" &&
                    item !== null &&
                    (item as { type?: unknown }).type === "text" &&
                    typeof (item as { text?: unknown }).text === "string"
                ) {
                    return (item as { text: string }).text;
                }
                return "";
            })
            .join("")
            .trim();
    }
    return "";
}

function oneLine(text: string, max = 160): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function parseChatStatus(content: string): string | undefined {
    const match = content.match(/^\[chat_status:([^\]]+)\]\s+chatId=\S+\s+(.*)$/);
    if (!match) return undefined;
    return `${match[1]}: ${match[2]}`;
}

function chatSummary(details: ChatInspection): string {
    const status = details.chat?.status ?? details.summary?.status ?? "unknown";
    const agentId = details.chat?.agentId ?? details.summary?.agentId ?? "?";
    const attempts = details.chat ? ` attempts=${details.chat.attempts}/${details.chat.maxRetries + 1}` : "";
    return `chat=${details.queryId} agent=${agentId} status=${status}${attempts}`;
}

function printChatDelta(details: ChatInspection, printedEnvelopes: Set<string>) {
    const sorted = details.threadMessages
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);

    for (const envelope of sorted) {
        if (!envelope.chatId || envelope.chatId !== details.queryId) continue;
        if (printedEnvelopes.has(envelope.envelopeId)) continue;
        printedEnvelopes.add(envelope.envelopeId);

        const raw = extractText(envelope.message.content);
        const statusLine = parseChatStatus(raw);
        if (statusLine) {
            console.log(`[chat] ${details.queryId} ${statusLine}`);
            continue;
        }

        const from = envelope.fromAgentId;
        const to = envelope.toAgentId;
        const preview = oneLine(raw || "(sin texto)");
        console.log(`[chat] ${details.queryId} ${from} -> ${to}: ${preview}`);
    }
}

async function streamChatView(runtime: MultiAgentRuntime, chatId: string): Promise<void> {
    const printedEnvelopes = new Set<string>();
    let previousSummary = "";

    while (true) {
        const details = await runtime.inspectChat(chatId);
        const hasData = Boolean(details.chat || details.summary || details.traceEvents.length || details.threadMessages.length);
        if (!hasData) {
            console.log("Chat no encontrado.");
            return;
        }

        const summary = chatSummary(details);
        if (summary !== previousSummary) {
            if (!previousSummary) {
                console.log(summary);
            } else {
                console.log(`[chat] ${summary}`);
            }
            previousSummary = summary;
        }

        printChatDelta(details, printedEnvelopes);

        const status = details.chat?.status ?? details.summary?.status;
        if (status === "closed") return;
        await Bun.sleep(400);
    }
}

function parseCommand(input: string): { command: string; args: string[] } {
    const [command = "", ...args] = input.trim().split(/\s+/);
    return { command: command.toLowerCase(), args };
}

async function runInteractiveCli(runtime: MultiAgentRuntime, rl?: ReturnType<typeof createInterface>) {
    const readline = rl ?? createInterface({ input: stdin, output: stdout });
    let currentAgent: ChatTarget = "orchestrator";

    console.log(`\nSesion: ${runtime.sessionId}`);
    console.log(`Agente activo: ${currentAgent}`);
    printHelp();

    while (true) {
        const rawInput = (await readline.question(`${currentAgent}> `)).trim();
        if (!rawInput) continue;

        if (rawInput.startsWith("/")) {
            const { command, args } = parseCommand(rawInput);
            if (command === "/exit" || command === "/quit") {
                break;
            }
            if (command === "/help") {
                printHelp();
                continue;
            }
            if (command === "/agents") {
                console.log(JSON.stringify(runtime.listAgents(), null, 2));
                continue;
            }
            if (command === "/use") {
                const maybeAgent = args[0] as ChatTarget | undefined;
                const exists = runtime.listAgents().some((agent) => agent.id === maybeAgent);
                if (!maybeAgent || !exists) {
                    console.log("Uso: /use orchestrator|code|math");
                    continue;
                }
                currentAgent = maybeAgent;
                console.log(`Agente activo => ${currentAgent}`);
                continue;
            }
            if (command === "/chats" || command === "/jobs") {
                console.log(JSON.stringify(runtime.listChats(), null, 2));
                continue;
            }
            if (command === "/chat" || command === "/job" || command === "/task") {
                const chatId = args.find((arg) => !arg.startsWith("--"));
                const asJson = args.includes("--json");
                if (!chatId) {
                    console.log("Uso: /chat <chatId> [--json]");
                    continue;
                }
                try {
                    const details = await runtime.inspectChat(chatId);
                    if (asJson) {
                        console.log(JSON.stringify(details, null, 2));
                    } else {
                        await streamChatView(runtime, chatId);
                    }
                } catch (err) { cliError(err); }
                continue;
            }
            if (command === "/close" || command === "/cancel") {
                const chatId = args[0];
                if (!chatId) {
                    console.log("Uso: /close <chatId>");
                    continue;
                }
                console.log(JSON.stringify(runtime.closeChat(chatId) ?? { error: "chat not found" }, null, 2));
                continue;
            }
            if (command === "/threads") {
                try {
                    const threads = await runtime.listThreadIds();
                    console.log(JSON.stringify(threads, null, 2));
                } catch (err) { cliError(err); }
                continue;
            }
            if (command === "/thread") {
                const threadId = args.join(" ");
                if (!threadId) {
                    console.log("Uso: /thread <threadId>");
                    continue;
                }
                try {
                    console.log(JSON.stringify(await runtime.getThread(threadId), null, 2));
                } catch (err) { cliError(err); }
                continue;
            }
            if (command === "/traces") {
                try {
                    const amount = Number(args[0] ?? "20");
                    const traces = await runtime.getTraces();
                    console.log(JSON.stringify(traces.slice(-Math.max(1, amount)), null, 2));
                } catch (err) { cliError(err); }
                continue;
            }
            if (command === "/smoke") {
                const smokeName = args[0] as (typeof VALID_SMOKES)[number] | undefined;
                if (!smokeName || !VALID_SMOKES.includes(smokeName)) {
                    console.log("Uso: /smoke math|code|orchestrator|explorer|writer|debugger|web-designer|marketing");
                    continue;
                }
                try {
                    const result = await runtime.runSmokeScenario(smokeName);
                    console.log(`\n[smoke:${smokeName}] ${result.answer}\n`);
                } catch (err) { cliError(err); }
                continue;
            }

            if (command === "/scheduled") {
                try {
                    const jobId = args[0];
                    if (jobId) {
                        const job = runtime.scheduler?.getJob(jobId);
                        console.log(job ? JSON.stringify(job, null, 2) : "Job not found.");
                    } else {
                        const jobs = runtime.scheduler?.listJobs() ?? [];
                        console.log(JSON.stringify(jobs, null, 2));
                    }
                } catch (err) { cliError(err); }
                continue;
            }
            if (command === "/cancel-job") {
                const jobId = args[0];
                if (!jobId) { console.log("Uso: /cancel-job <jobId>"); continue; }
                const removed = runtime.scheduler?.removeJob(jobId);
                console.log(removed ? "Job cancelled." : "Job not found.");
                continue;
            }

            console.log("Comando no reconocido. Usa /help.");
            continue;
        }

        try {
            const result = await runtime.chat({
                fromAgentId: "user",
                toAgentId: currentAgent,
                content: rawInput,
            });
            console.log(`\n${currentAgent}: ${result.answer || "(sin texto)"}\n`);
        } catch (error) {
            cliError(error);
        }
    }

    readline.close();
}

const args = parseArgs(Bun.argv.slice(2));

if (args.smoke) {
    const runtime = new MultiAgentRuntime({
        sessionId: args.sessionId,
    });
    const result = await runtime.runSmokeScenario(args.smoke);
    console.log(`[smoke:${args.smoke}] ${result.answer}`);
} else {
    const rl = createInterface({ input: stdin, output: stdout });
    const runtime = new MultiAgentRuntime({
        sessionId: args.sessionId,
        hitlHandler: createCliHitlHandler(rl),
    });
    await runInteractiveCli(runtime, rl);
}
