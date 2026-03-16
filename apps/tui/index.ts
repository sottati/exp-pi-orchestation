import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";
import type { AgentChat, BaseAgentId, TraceEvent } from "../../packages/core/contracts";
import { errorMessage } from "../../packages/core/errors";
import { MultiAgentRuntime } from "../../packages/core/runtime";

type ChatTarget = Exclude<BaseAgentId, "user">;

const AGENT_ORDER: ChatTarget[] = ["orchestrator", "code", "math"];
const SMOKE_ORDER = ["math", "code", "orchestrator"] as const;
const MAX_LOG_LINES = 400;
const DIAGNOSTIC_CHAT_LINES = 8;
const DIAGNOSTIC_TRACE_LINES = 10;
const MIN_CHAT_WIDTH = 24;
const LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LOADER_INTERVAL_MS = 90;
const AGENT_OUTPUT_THEME: Record<
    ChatTarget,
    { borderColor: string; backgroundColor: string; textColor: string }
> = {
    orchestrator: {
        borderColor: "#6ea8ff",
        backgroundColor: "#0f1f34",
        textColor: "#d7e7ff",
    },
    code: {
        borderColor: "#6fd6a7",
        backgroundColor: "#0f2a22",
        textColor: "#d6fbe9",
    },
    math: {
        borderColor: "#f2c879",
        backgroundColor: "#2f2412",
        textColor: "#ffefd0",
    },
};

type MessageAlign = "left" | "right";
type MessageLogOptions = {
    align?: MessageAlign;
    spacer?: boolean;
    agent?: ChatTarget;
};

function parseArgs(args: string[]) {
    let sessionId = "default";
    for (let i = 0; i < args.length; i += 1) {
        const current = args[i];
        const next = args[i + 1];
        if (current === "--session" && next) {
            sessionId = next;
            i += 1;
        }
    }
    return { sessionId };
}

function oneLine(text: string, max = 120): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function textFromEvent(event: AgentEvent): string | undefined {
    if (event.type !== "message_update") return undefined;
    if (event.assistantMessageEvent.type !== "text_delta") return undefined;
    return event.assistantMessageEvent.delta;
}

function describeToolStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): string {
    const args = event.args as Record<string, unknown>;
    if (event.toolName === "delegate" || event.toolName === "delegate_task") {
        return `delegate -> ${String(args.agentId ?? "?")}: ${oneLine(String(args.task ?? ""))}`;
    }
    if (event.toolName === "follow_up_chat") {
        return `follow_up_chat -> ${String(args.chatId ?? "?")}`;
    }
    if (event.toolName === "get_chat_status" || event.toolName === "get_chat_result" || event.toolName === "close_chat") {
        return `${event.toolName} -> ${String(args.chatId ?? "?")}`;
    }
    if (event.toolName === "run_bash") {
        return `run_bash -> ${oneLine(String(args.command ?? ""))}`;
    }
    return event.toolName;
}

function formatChat(chat: AgentChat): string {
    const queue = chat.status === "waiting" ? " (queued)" : "";
    const reason = chat.status === "closed" ? ` ${chat.closeReason ?? "unknown"}` : "";
    return `${chat.chatId} ${chat.agentId} ${chat.status}${queue}${reason}`;
}

function formatTrace(trace: TraceEvent): string {
    const prefix = `[${trace.type}]`;
    if (trace.toolName) {
        return `${prefix} ${trace.toolName} (${trace.status})`;
    }
    if (trace.chatId) {
        return `${prefix} chat=${trace.chatId} (${trace.status})`;
    }
    return `${prefix} ${trace.status}`;
}

function wrapText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const output: string[] = [];
    for (const rawLine of text.split("\n")) {
        if (!rawLine) {
            output.push("");
            continue;
        }

        let remaining = rawLine;
        while (remaining.length > safeWidth) {
            const splitAt = remaining.lastIndexOf(" ", safeWidth);
            if (splitAt <= 0) {
                output.push(remaining.slice(0, safeWidth));
                remaining = remaining.slice(safeWidth);
                continue;
            }
            output.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt + 1).trimStart();
        }
        output.push(remaining);
    }
    return output;
}

async function main() {
    const args = parseArgs(Bun.argv.slice(2));
    const runtime = new MultiAgentRuntime(args.sessionId);
    const renderer = await createCliRenderer({
        useConsole: false,
        useAlternateScreen: true,
        exitOnCtrlC: true,
        useMouse: true,
    });

    const root = new BoxRenderable(renderer, {
        id: "root",
        width: "100%",
        height: "100%",
        flexDirection: "column",
    });

    const header = new BoxRenderable(renderer, {
        id: "header",
        border: true,
        title: "pi-agent-core TUI",
        height: 4,
        width: "100%",
    });
    const headerText = new TextRenderable(renderer, {
        id: "header-text",
        width: "100%",
        height: "100%",
        content: "",
    });
    header.add(headerText);

    const body = new BoxRenderable(renderer, {
        id: "body",
        width: "100%",
        flexGrow: 1,
        flexDirection: "row",
    });

    const outputPanel = new ScrollBoxRenderable(renderer, {
        id: "output-panel",
        title: "Salida y streaming",
        border: true,
        width: "70%",
        height: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        padding: 1,
    });
    const outputText = new TextRenderable(renderer, {
        id: "output-text",
        width: "100%",
        content: "",
    });
    outputPanel.add(outputText);

    const diagnosticsPanel = new ScrollBoxRenderable(renderer, {
        id: "diagnostics-panel",
        title: "Chats, tools y trazas",
        border: true,
        width: "30%",
        height: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        padding: 1,
    });
    const diagnosticsText = new TextRenderable(renderer, {
        id: "diagnostics-text",
        width: "100%",
        content: "",
    });
    diagnosticsPanel.add(diagnosticsText);

    body.add(outputPanel);
    body.add(diagnosticsPanel);

    const footer = new BoxRenderable(renderer, {
        id: "footer",
        border: true,
        title: "Entrada",
        width: "100%",
        height: 3,
        paddingLeft: 1,
        paddingRight: 1,
    });
    const input = new InputRenderable(renderer, {
        id: "input",
        width: "100%",
        placeholder: "Escribe mensaje y presiona Enter",
    });
    footer.add(input);

    root.add(header);
    root.add(body);
    root.add(footer);
    renderer.root.add(root);

    let currentAgent: ChatTarget = "orchestrator";
    let isBusy = false;
    let streamBuffer = "";
    let statusMessage = "Lista.";
    const logLinesByAgent: Record<ChatTarget, string[]> = {
        orchestrator: [],
        code: [],
        math: [],
    };
    let runningAgent: ChatTarget | undefined;
    let loaderFrame = 0;
    let loaderTimer: ReturnType<typeof setInterval> | undefined;
    let diagnosticsBody = "Cargando…";
    let diagnosticsTimer: ReturnType<typeof setInterval> | undefined;
    let shuttingDown = false;

    function currentLoaderGlyph() {
        return LOADER_FRAMES[loaderFrame % LOADER_FRAMES.length];
    }

    function loadingPreview() {
        return `${currentLoaderGlyph()} pensando...`;
    }

    function startLoader() {
        if (loaderTimer) return;
        loaderTimer = setInterval(() => {
            loaderFrame = (loaderFrame + 1) % LOADER_FRAMES.length;
            if (!isBusy) return;
            renderHeader();
            renderOutput();
        }, LOADER_INTERVAL_MS);
    }

    function stopLoader() {
        if (loaderTimer) {
            clearInterval(loaderTimer);
            loaderTimer = undefined;
        }
        loaderFrame = 0;
    }

    function chatWidth(): number {
        const width = outputPanel.width;
        if (!Number.isFinite(width) || width <= 0) return 80;
        return Math.max(MIN_CHAT_WIDTH, width - 6);
    }

    function rightAlignLine(line: string, width: number): string {
        if (!line) return line;
        if (line.length >= width) return line;
        return `${" ".repeat(width - line.length)}${line}`;
    }

    function pushLog(line: string, options: MessageLogOptions = {}) {
        const align = options.align ?? "left";
        const spacer = options.spacer ?? false;
        const targetAgent = options.agent ?? currentAgent;
        const targetLog = logLinesByAgent[targetAgent];
        const width = chatWidth();
        const wrapped = wrapText(line, width);
        for (const part of wrapped) {
            targetLog.push(align === "right" ? rightAlignLine(part, width) : part);
        }
        if (spacer) {
            targetLog.push("");
        }
        if (targetLog.length > MAX_LOG_LINES) {
            targetLog.splice(0, targetLog.length - MAX_LOG_LINES);
        }
        if (targetAgent === currentAgent) {
            renderOutput();
        }
    }

    function setStatus(text: string) {
        statusMessage = oneLine(text, 160);
        renderHeader();
    }

    function applyOutputTheme(agent: ChatTarget) {
        const theme = AGENT_OUTPUT_THEME[agent];
        outputPanel.borderColor = theme.borderColor;
        outputPanel.backgroundColor = theme.backgroundColor;
        outputText.fg = theme.textColor;
    }

    function renderHeader() {
        const mode = isBusy ? `EJECUTANDO ${currentLoaderGlyph()}` : "LISTO";
        applyOutputTheme(currentAgent);
        outputPanel.title = currentAgent;
        headerText.content = [
            `session=${runtime.sessionId}  agente=${currentAgent}  estado=${mode}`,
            "Tab: cambiar agente  Ctrl+R: refrescar  Ctrl+T: smoke all  Ctrl+L: limpiar  Esc: salir",
            `status: ${statusMessage}`,
        ].join("\n");
    }

    function renderOutput() {
        const lines = [...logLinesByAgent[currentAgent]];
        if (isBusy && runningAgent === currentAgent) {
            const preview = streamBuffer || loadingPreview();
            lines.push(...wrapText(preview, chatWidth()));
        }
        outputText.content = lines.join("\n");
        outputPanel.scrollTop = outputPanel.scrollHeight;
    }

    function renderDiagnostics() {
        diagnosticsText.content = diagnosticsBody;
        diagnosticsPanel.scrollTop = diagnosticsPanel.scrollHeight;
    }

    function clearOutput() {
        logLinesByAgent[currentAgent].length = 0;
        streamBuffer = "";
        renderOutput();
    }

    function cycleAgent() {
        const idx = AGENT_ORDER.indexOf(currentAgent);
        const next = AGENT_ORDER[(idx + 1) % AGENT_ORDER.length];
        if (next) {
            currentAgent = next;
            setStatus(`Agente activo -> ${currentAgent}`);
            renderOutput();
        }
    }

    async function refreshDiagnostics() {
        try {
            const chats = runtime.listChats().slice().sort((a, b) => b.updatedAt - a.updatedAt);
            const traces = (await runtime.getTraces()).slice(-80);
            const active = chats.filter((c) => c.status === "active").length;
            const waiting = chats.filter((c) => c.status === "waiting").length;
            const closed = chats.filter((c) => c.status === "closed").length;
            const chatLines = chats
                .slice(0, DIAGNOSTIC_CHAT_LINES)
                .map((chat) => `- ${formatChat(chat)}`);

            const traceLines = traces
                .slice()
                .reverse()
                .filter((trace) => {
                    return trace.type.startsWith("chat_") || trace.type === "tool_start" || trace.type === "tool_end";
                })
                .slice(0, DIAGNOSTIC_TRACE_LINES)
                .reverse()
                .map((trace) => `- ${formatTrace(trace)}`);

            diagnosticsBody = [
                `Chats: active=${active} waiting=${waiting} closed=${closed}`,
                "",
                "Ultimos chats:",
                ...(chatLines.length ? chatLines : ["- (sin chats)"]),
                "",
                "Ultimos eventos tool/chat:",
                ...(traceLines.length ? traceLines : ["- (sin eventos)"]),
            ].join("\n");
        } catch (err) {
            diagnosticsBody = `No se pudieron cargar diagnosticos:\n${errorMessage(err)}`;
        }
        renderDiagnostics();
    }

    async function runSmokeChecks() {
        if (isBusy) {
            setStatus("Hay una ejecución en curso; espera para correr smoke.");
            return;
        }
        isBusy = true;
        startLoader();
        streamBuffer = "";
        renderHeader();
        renderOutput();
        pushLog("[check] Ejecutando smoke suite (math, code, orchestrator)...");
        for (const smokeName of SMOKE_ORDER) {
            try {
                const output = await runtime.runSmokeScenario(smokeName);
                pushLog(`[check:${smokeName}] OK -> ${oneLine(output.answer || "(sin texto)", 180)}`);
            } catch (err) {
                pushLog(`[check:${smokeName}] ERROR -> ${errorMessage(err)}`);
            }
        }
        isBusy = false;
        stopLoader();
        streamBuffer = "";
        setStatus("Smoke suite finalizada.");
        renderOutput();
        await refreshDiagnostics();
        input.focus();
    }

    async function sendPrompt() {
        const message = input.value.trim();
        if (!message) return;
        if (isBusy) {
            setStatus("Hay una ejecución en curso; espera.");
            return;
        }

        input.value = "";
        isBusy = true;
        startLoader();
        const targetAgent = currentAgent;
        runningAgent = targetAgent;
        streamBuffer = "";
        renderHeader();
        renderOutput();

        pushLog(message, { align: "right", spacer: true, agent: targetAgent });
        setStatus(`Enviando mensaje a ${targetAgent}...`);

        try {
            const output = await runtime.chat({
                fromAgentId: "user",
                toAgentId: targetAgent,
                content: message,
                onAgentEvent: (event) => {
                    const delta = textFromEvent(event);
                    if (delta) {
                        streamBuffer += delta;
                        renderOutput();
                        return;
                    }

                    if (event.type === "tool_execution_start") {
                        pushLog(`[tool:start] ${describeToolStart(event)}`, { agent: targetAgent });
                        return;
                    }
                    if (event.type === "tool_execution_end") {
                        pushLog(`[tool:${event.isError ? "error" : "ok"}] ${event.toolName}`, { agent: targetAgent });
                    }
                },
            });

            const finalAnswer = streamBuffer.trim() || output.answer || "(sin texto)";
            streamBuffer = "";
            pushLog(finalAnswer, { align: "left", spacer: true, agent: targetAgent });
            pushLog(`[run] ${output.runContext.runId} completado en ${output.durationMs}ms`, { agent: targetAgent });
            setStatus(`Respuesta recibida de ${targetAgent}.`);
        } catch (err) {
            streamBuffer = "";
            pushLog(`[error] ${errorMessage(err)}`, { agent: targetAgent });
            setStatus("La ejecución terminó con error.");
        } finally {
            isBusy = false;
            stopLoader();
            runningAgent = undefined;
            renderHeader();
            renderOutput();
            await refreshDiagnostics();
            input.focus();
        }
    }

    input.on("enter", () => {
        void sendPrompt();
    });

    renderer.keyInput.on("keypress", (key) => {
        if (key.name === "tab") {
            key.preventDefault();
            cycleAgent();
            return;
        }
        if (key.ctrl && key.name === "r") {
            key.preventDefault();
            void refreshDiagnostics();
            setStatus("Diagnósticos refrescados.");
            return;
        }
        if (key.ctrl && key.name === "l") {
            key.preventDefault();
            clearOutput();
            setStatus("Salida limpiada.");
            return;
        }
        if (key.ctrl && key.name === "t") {
            key.preventDefault();
            void runSmokeChecks();
            return;
        }
        if (key.name === "escape") {
            key.preventDefault();
            shutdown(0);
        }
    });

    function shutdown(code: number) {
        if (shuttingDown) return;
        shuttingDown = true;
        if (diagnosticsTimer) clearInterval(diagnosticsTimer);
        if (loaderTimer) clearInterval(loaderTimer);
        try {
            renderer.destroy();
        } catch {
            // ignore destroy errors on shutdown
        }
        process.exit(code);
    }

    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGINT", () => shutdown(0));

    renderHeader();
    renderOutput();
    renderDiagnostics();
    renderer.start();
    input.focus();
    await refreshDiagnostics();
    diagnosticsTimer = setInterval(() => {
        void refreshDiagnostics();
    }, 1500);
}

void main().catch((err) => {
    console.error("[tui] fatal:", errorMessage(err));
    process.exit(1);
});
