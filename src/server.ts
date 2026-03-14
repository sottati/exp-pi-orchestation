// @ts-ignore — Bun HTML import (bundled automatically)
import index from "./web/index.html";
import { MultiAgentRuntime } from "./runtime";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { TraceEvent, AgentChat, BaseAgentId } from "./contracts";
import { errorMessage } from "./errors";

const sessionIdx = process.argv.indexOf("--session");
const sessionId = sessionIdx !== -1 ? process.argv[sessionIdx + 1] : "default";

const runtime = new MultiAgentRuntime(sessionId);

type WsClient = import("bun").ServerWebSocket<unknown>;
const clients = new Set<WsClient>();

function broadcast(msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
        try { ws.send(text); } catch { /* ignore closed socket */ }
    }
}

// Monkey-patch for real-time trace push
const _appendTrace = runtime.store.appendTrace.bind(runtime.store);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(runtime.store as any).appendTrace = async (event: TraceEvent) => {
    await _appendTrace(event);
    broadcast({ type: "trace", event });
};

// Monkey-patch for chat lifecycle push
const _appendChatRecord = runtime.store.appendChatRecord.bind(runtime.store);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(runtime.store as any).appendChatRecord = async (chat: AgentChat) => {
    await _appendChatRecord(chat);
    broadcast({ type: "chat_lifecycle", chat });
};

function getAgentForId(agentId: string) {
    if (agentId === "orchestrator") return runtime.orchestratorAgent;
    const reg = runtime.specialistRegistry as Record<string, { agent: import("@mariozechner/pi-agent-core").Agent } | undefined>;
    return reg[agentId]?.agent;
}

const PORT = 3000;

Bun.serve({
    port: PORT,
    routes: {
        "/": index,
        "/ws": (req, server) => {
            if (server.upgrade(req)) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        },
        "/api/agents": {
            GET: () => Response.json(runtime.listAgents()),
        },
        "/api/chats": {
            GET: () => Response.json(runtime.listChats()),
        },
        "/api/chats/:id": {
            GET: (req) => {
                const chat = runtime.getChat(req.params.id);
                return chat
                    ? Response.json(chat)
                    : Response.json({ error: "not found" }, { status: 404 });
            },
            DELETE: (req) => {
                const chat = runtime.closeChat(req.params.id);
                return chat
                    ? Response.json(chat)
                    : Response.json({ error: "not found" }, { status: 404 });
            },
        },
        "/api/threads": {
            GET: async () => Response.json(await runtime.listThreadIds()),
        },
        "/api/threads/:id": {
            GET: async (req) => Response.json(await runtime.getThread(decodeURIComponent(req.params.id))),
        },
        "/api/traces": {
            GET: async () => Response.json(await runtime.getTraces()),
        },
    },
    websocket: {
        open(ws) {
            clients.add(ws);
            ws.send(JSON.stringify({ type: "agents", agents: runtime.listAgents() }));
        },
        close(ws) {
            clients.delete(ws);
        },
        message(ws, data) {
            const text = typeof data === "string" ? data : data.toString();
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(text);
            } catch {
                return;
            }

            if (msg.type === "chat") {
                const toAgentId = msg.toAgentId as Exclude<BaseAgentId, "user">;
                const content = msg.content as string;
                const agent = getAgentForId(toAgentId);
                const runId = crypto.randomUUID();

                ws.send(JSON.stringify({ type: "chat_sending", runId, toAgentId }));

                let unsubscribe: (() => void) | undefined;
                if (agent) {
                    unsubscribe = agent.subscribe((event: AgentEvent) => {
                        if (
                            event.type === "message_update" &&
                            event.assistantMessageEvent.type === "text_delta"
                        ) {
                            ws.send(JSON.stringify({
                                type: "stream_delta",
                                runId,
                                delta: event.assistantMessageEvent.delta,
                            }));
                        }
                    });
                }

                runtime.chat({ toAgentId, content })
                    .then((output) => {
                        unsubscribe?.();
                        ws.send(JSON.stringify({
                            type: "stream_end",
                            runId,
                            answer: output.answer,
                            durationMs: output.durationMs,
                        }));
                    })
                    .catch((err) => {
                        unsubscribe?.();
                        ws.send(JSON.stringify({
                            type: "stream_error",
                            runId,
                            error: errorMessage(err),
                        }));
                    });

            } else if (msg.type === "close_chat") {
                runtime.closeChat(msg.chatId as string);
            }
        },
    },
    development: { hmr: true, console: true },
});

console.log(`[server] pi-agent UI → http://localhost:${PORT}  (session: ${sessionId})`);
