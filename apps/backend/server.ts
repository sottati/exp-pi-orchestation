// @ts-ignore — Bun HTML import (bundled automatically)
import index from "../web/index.html";
import { MultiAgentRuntime } from "../../packages/core/runtime";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { TraceEvent, AgentChat, ScheduledJob, BaseAgentId } from "../../packages/core/contracts";
import { errorMessage } from "../../packages/core/errors";
import type { HITLHandler } from "../../packages/core/tool-middleware";
import { createAgentDefinitions } from "../../packages/core/agents";
import { buildHydratedUiState, getPrimaryThreadId } from "../web/ui-state";

const sessionIdx = process.argv.indexOf("--session");
const sessionId = sessionIdx !== -1 ? (process.argv[sessionIdx + 1] ?? "default") : "default";

type WsClient = import("bun").ServerWebSocket<unknown>;
const clients = new Set<WsClient>();

const hitlPending = new Map<string, (response: { approved: boolean; modifiedParams?: Record<string, unknown> }) => void>();

function createWebHitlHandler(wsClients: Set<WsClient>): HITLHandler {
    return (request) => {
        return new Promise((resolve) => {
            const reqId = crypto.randomUUID();
            const msg = JSON.stringify({ type: "hitl_request", reqId, ...request });
            for (const ws of wsClients) {
                try { ws.send(msg); } catch { /* ignore */ }
            }

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    hitlPending.delete(reqId);
                    resolve({ approved: false });
                }
            }, request.timeout);

            hitlPending.set(reqId, (response) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                resolve(response);
            });
        });
    };
}

const runtime = new MultiAgentRuntime({
    sessionId,
    agents: createAgentDefinitions(),
    hitlHandler: createWebHitlHandler(clients),
});

function broadcast(msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
        try { ws.send(text); } catch { /* ignore closed socket */ }
    }
}

const delegationStarts = new Map<string, {
    runId: string;
    fromAgentId: string;
    toAgentId: string;
    task: string;
    timestamp: number;
}>();

// Monkey-patch for real-time trace push
const _appendTrace = runtime.store.appendTrace.bind(runtime.store);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(runtime.store as any).appendTrace = async (event: TraceEvent) => {
    await _appendTrace(event);
    broadcast({ type: "trace", event });

    // Delegation tracking: emit delegation_start on tool_start for delegate tools
    if (
        event.type === "tool_start" &&
        event.toolCallId &&
        (event.toolName === "delegate" || event.toolName === "delegate_task")
    ) {
        const details = event.details as Record<string, unknown> | undefined;
        const args = details?.args as Record<string, unknown> | undefined;
        const taskFromTrace = details?.task ?? args?.task;
        const info = {
            runId: event.runId,
            fromAgentId: event.agentId ?? "orchestrator",
            toAgentId: String(details?.agentId ?? args?.agentId ?? "unknown"),
            task: String(taskFromTrace ?? ""),
            timestamp: event.timestamp,
        };
        delegationStarts.set(event.toolCallId, info);
        broadcast({
            type: "delegation_start",
            runId: info.runId,
            delegationId: event.toolCallId,
            fromAgentId: info.fromAgentId,
            toAgentId: info.toAgentId,
            task: info.task,
        });
    }

    // Delegation tracking: emit delegation_end on tool_end for matching toolCallId
    if (
        event.type === "tool_end" &&
        event.toolCallId &&
        delegationStarts.has(event.toolCallId)
    ) {
        const start = delegationStarts.get(event.toolCallId)!;
        delegationStarts.delete(event.toolCallId);
        const details = event.details as Record<string, unknown> | undefined;
        broadcast({
            type: "delegation_end",
            runId: start.runId,
            delegationId: event.toolCallId,
            result: String(details?.result ?? ""),
            durationMs: event.timestamp - start.timestamp,
            status: event.status === "ok" ? "ok" : "error",
        });
    }
};

// Monkey-patch for chat lifecycle push
const _appendChatRecord = runtime.store.appendChatRecord.bind(runtime.store);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(runtime.store as any).appendChatRecord = async (chat: AgentChat) => {
    await _appendChatRecord(chat);
    broadcast({ type: "chat_lifecycle", chat });
};

// Monkey-patch for job lifecycle push
const _appendJob = runtime.store.appendJob.bind(runtime.store);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(runtime.store as any).appendJob = async (job: ScheduledJob) => {
    await _appendJob(job);
    broadcast({ type: "job_lifecycle", job });
};

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
        "/api/ui-state": {
            GET: async () => {
                const traces = await runtime.getTraces();
                const threadMessages = await runtime.getThread(getPrimaryThreadId(sessionId));
                return Response.json(buildHydratedUiState({
                    agents: runtime.listAgents(),
                    sessionId,
                    threadMessages,
                    traces,
                }));
            },
        },
        "/api/jobs": {
            GET: () => Response.json(runtime.scheduler?.listJobs() ?? []),
        },
        "/api/jobs/:id": {
            GET: (req) => {
                const job = runtime.scheduler?.getJob(req.params.id);
                return job ? Response.json(job) : Response.json({ error: "not found" }, { status: 404 });
            },
            DELETE: (req) => {
                const removed = runtime.scheduler?.removeJob(req.params.id);
                return removed ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
            },
        },
    },
    websocket: {
        open(ws) {
            clients.add(ws);
            ws.send(JSON.stringify({ type: "agents", agents: runtime.listAgents(), sessionId }));
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
                const runId = crypto.randomUUID();

                ws.send(JSON.stringify({ type: "chat_sending", runId, toAgentId }));

                runtime.chat({
                    toAgentId,
                    content,
                    onAgentEvent: (event: AgentEvent) => {
                        if (
                            event.type === "message_update" &&
                            event.assistantMessageEvent.type === "text_delta"
                        ) {
                            ws.send(JSON.stringify({
                                type: "stream_delta",
                                runId,
                                delta: event.assistantMessageEvent.delta,
                            }));
                        } else if (event.type === "tool_execution_start") {
                            const args = event.args as Record<string, unknown>;
                            let label = `→ ${event.toolName}`;
                            if (event.toolName === "delegate" || event.toolName === "delegate_task") {
                                label = `→ delegate → ${args.agentId}: ${String(args.task ?? "").slice(0, 80)}`;
                            } else if (event.toolName === "get_chat_result" || event.toolName === "get_chat_status") {
                                label = `→ ${event.toolName} → ${String(args.chatId ?? "")}`;
                            }
                            ws.send(JSON.stringify({ type: "stream_status", runId, text: label }));
                        }
                    },
                })
                    .then((output) => {
                        ws.send(JSON.stringify({
                            type: "stream_end",
                            runId,
                            answer: output.answer,
                            durationMs: output.durationMs,
                        }));
                    })
                    .catch((err) => {
                        ws.send(JSON.stringify({
                            type: "stream_error",
                            runId,
                            error: errorMessage(err),
                        }));
                    });

            } else if (msg.type === "close_chat") {
                runtime.closeChat(msg.chatId as string);
            } else if (msg.type === "hitl_response") {
                const reqId = msg.reqId as string;
                const resolver = hitlPending.get(reqId);
                if (resolver) {
                    hitlPending.delete(reqId);
                    resolver({
                        approved: msg.approved as boolean,
                        modifiedParams: msg.modifiedParams as Record<string, unknown> | undefined,
                    });
                }
            }
        },
    },
    development: { hmr: true, console: true },
});

console.log(`[server] pi-agent UI → http://localhost:${PORT}  (session: ${sessionId})`);
