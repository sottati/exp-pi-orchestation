import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { BaseAgentId } from "./contracts";
import { errorMessage } from "./errors";
import { MultiAgentRuntime } from "./runtime";

function cliError(err: unknown) { console.error("Error:", errorMessage(err)); }

type ChatTarget = Exclude<BaseAgentId, "user">;
const VALID_SMOKES = ["math", "code", "orchestrator"] as const;

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

function printHelp() {
    console.log("\nComandos:");
    console.log("  /help                  muestra esta ayuda");
    console.log("  /agents                lista agentes disponibles");
    console.log("  /use <agentId>         cambia agente activo");
    console.log("  /chats                 lista chats activos + en cola");
    console.log("  /chat <chatId>         vista detallada de un chat");
    console.log("  /close <chatId>        cierra un chat");
    console.log("  /threads               lista threadIds");
    console.log("  /thread <threadId>     muestra mensajes del thread");
    console.log("  /traces [n]            muestra ultimos n eventos de traza (default 20)");
    console.log("  /smoke <name>          corre smoke (math|code|orchestrator)");
    console.log("  /exit                  salir");
    console.log("  (aliases: /jobs=/chats, /job=/task=/chat, /cancel=/close)\n");
}

function parseCommand(input: string): { command: string; args: string[] } {
    const [command = "", ...args] = input.trim().split(/\s+/);
    return { command: command.toLowerCase(), args };
}

async function runInteractiveCli(runtime: MultiAgentRuntime) {
    const rl = createInterface({ input: stdin, output: stdout });
    let currentAgent: ChatTarget = "orchestrator";

    console.log(`\nSesion: ${runtime.sessionId}`);
    console.log(`Agente activo: ${currentAgent}`);
    printHelp();

    while (true) {
        const rawInput = (await rl.question(`${currentAgent}> `)).trim();
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
                const chatId = args[0];
                if (!chatId) {
                    console.log("Uso: /chat <chatId>");
                    continue;
                }
                try {
                    const details = await runtime.inspectChat(chatId);
                    console.log(JSON.stringify(details, null, 2));
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
                    console.log("Uso: /smoke math|code|orchestrator");
                    continue;
                }
                try {
                    const result = await runtime.runSmokeScenario(smokeName);
                    console.log(`\n[smoke:${smokeName}] ${result.answer}\n`);
                } catch (err) { cliError(err); }
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

    rl.close();
}

const args = parseArgs(Bun.argv.slice(2));
const runtime = new MultiAgentRuntime(args.sessionId);

if (args.smoke) {
    const result = await runtime.runSmokeScenario(args.smoke);
    console.log(`[smoke:${args.smoke}] ${result.answer}`);
} else {
    await runInteractiveCli(runtime);
}
