// @ts-ignore — Bun HTML import (bundled automatically)
import index from "../web/index.html";
import { MultiAgentRuntime } from "../../packages/core/runtime";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { TraceEvent, AgentChat, ScheduledJob, BaseAgentId } from "../../packages/core/contracts";
import { errorMessage } from "../../packages/core/errors";
import type { HITLHandler, HITLRequest } from "../../packages/core/tool-middleware";

const sessionIdx = process.argv.indexOf("--session");
const sessionId = sessionIdx !== -1 ? process.argv[sessionIdx + 1] : "default";

type WsClient = import("bun").ServerWebSocket<unknown>;
const clients = new Set<WsClient>();

interface PendingHitlRequest {
    reqId: string;
    request: HITLRequest;
    resolve: (response: { approved: boolean; modifiedParams?: Record<string, unknown> }) => void;
    reject: (err: Error) => void;
    seen: boolean;
    resolved: boolean;
    timeoutHandle?: ReturnType<typeof setTimeout>;
}

const hitlPending = new Map<string, PendingHitlRequest>();

function sendWsJson(ws: WsClient, payload: object): boolean {
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function broadcastHitlRequest(wsClients: Set<WsClient>, pending: PendingHitlRequest): number {
    const payload = { type: "hitl_request", reqId: pending.reqId, ...pending.request };
    let delivered = 0;
    for (const ws of wsClients) {
        if (sendWsJson(ws, payload)) {
            delivered += 1;
        }
    }
    console.error(
        `[hitl] request ${pending.reqId} ${pending.request.agentId}:${pending.request.toolName} delivered=${delivered} connected=${wsClients.size}`,
    );
    return delivered;
}

function startHitlTimeout(wsClients: Set<WsClient>, pending: PendingHitlRequest): void {
    if (pending.resolved || pending.timeoutHandle) return;
    pending.timeoutHandle = setTimeout(() => {
        if (pending.resolved) return;
        pending.resolved = true;
        hitlPending.delete(pending.reqId);

        for (const ws of wsClients) {
            sendWsJson(ws, {
                type: "hitl_expired",
                reqId: pending.reqId,
                agentId: pending.request.agentId,
                toolName: pending.request.toolName,
                timeout: pending.request.timeout,
            });
        }

        console.error(`[hitl] request ${pending.reqId} timed out after ${pending.request.timeout}ms`);
        pending.reject(new Error("HITL_TIMEOUT"));
    }, pending.request.timeout);
}

function markHitlSeen(wsClients: Set<WsClient>, reqId: string): void {
    const pending = hitlPending.get(reqId);
    if (!pending || pending.resolved || pending.seen) return;
    pending.seen = true;
    console.error(`[hitl] request ${reqId} acknowledged by UI; timeout started (${pending.request.timeout}ms)`);
    startHitlTimeout(wsClients, pending);
}

function resolveHitlRequest(
    wsClients: Set<WsClient>,
    reqId: string,
    response: { approved: boolean; modifiedParams?: Record<string, unknown> },
): boolean {
    const pending = hitlPending.get(reqId);
    if (!pending || pending.resolved) return false;
    pending.resolved = true;
    if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
    }
    hitlPending.delete(reqId);
    console.error(`[hitl] request ${reqId} response approved=${response.approved}`);
    pending.resolve(response);

    for (const ws of wsClients) {
        sendWsJson(ws, { type: "hitl_resolved", reqId, approved: response.approved });
    }
    return true;
}

function replayPendingHitlToClient(ws: WsClient): void {
    let replayed = 0;
    for (const pending of hitlPending.values()) {
        if (sendWsJson(ws, { type: "hitl_request", reqId: pending.reqId, ...pending.request })) {
            replayed += 1;
        }
    }
    if (replayed > 0) {
        console.error(`[hitl] replayed ${replayed} pending request(s) to newly connected UI client`);
    }
}

function createWebHitlHandler(wsClients: Set<WsClient>): HITLHandler {
    return (request) => {
        return new Promise((resolve, reject) => {
            const reqId = crypto.randomUUID();
            const pending: PendingHitlRequest = {
                reqId,
                request,
                resolve,
                reject: (err) => reject(err),
                seen: false,
                resolved: false,
            };
            hitlPending.set(reqId, pending);

            const delivered = broadcastHitlRequest(wsClients, pending);
            if (delivered === 0) {
                console.error(
                    `[hitl] request ${reqId} queued waiting for UI connection (timeout not started yet).`,
                );
            } else {
                console.error(
                    `[hitl] request ${reqId} delivered; waiting for UI acknowledgment before starting timeout.`,
                );
            }
        });
    };
}

function broadcast(msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
        try { ws.send(text); } catch { /* ignore closed socket */ }
    }
}

function sanitizeThoughtPrefix(text: string): string {
    let next = text;
    while (true) {
        const replaced = next.replace(/^\s*(?:\.\s*)?thought:\s*/i, "");
        if (replaced === next) break;
        next = replaced;
    }
    return next;
}

const runtime = new MultiAgentRuntime({
    sessionId,
    hitlHandler: createWebHitlHandler(clients),
});

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
        const info = {
            runId: event.runId,
            fromAgentId: event.agentId ?? "orchestrator",
            toAgentId: String(details?.agentId ?? "unknown"),
            task: String(details?.task ?? ""),
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
        "/api/agents/:id/activity": {
            GET: async (req) => {
                const agentId = req.params.id;
                const allTraces = await runtime.getTraces();
                const agentTraces = allTraces.filter(
                    (t: TraceEvent) => t.agentId === agentId
                ).slice(-100);
                const allChats = runtime.listChats();
                const agentChats = allChats.filter(
                    (c: AgentChat) => c.agentId === agentId
                );
                const allJobs = runtime.scheduler?.listJobs() ?? [];
                const agentJobs = allJobs.filter(
                    (j: ScheduledJob) => j.targetAgentId === agentId || j.createdBy === agentId
                );
                return Response.json({ traces: agentTraces, chats: agentChats, jobs: agentJobs });
            },
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
            replayPendingHitlToClient(ws);
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
                            const delta = sanitizeThoughtPrefix(event.assistantMessageEvent.delta);
                            if (!delta) return;
                            ws.send(JSON.stringify({
                                type: "stream_delta",
                                runId,
                                delta,
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
                            answer: sanitizeThoughtPrefix(output.answer),
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
            } else if (msg.type === "hitl_seen") {
                const reqId = msg.reqId as string;
                markHitlSeen(clients, reqId);
            } else if (msg.type === "hitl_response") {
                const reqId = msg.reqId as string;
                resolveHitlRequest(clients, reqId, {
                    approved: msg.approved as boolean,
                    modifiedParams: msg.modifiedParams as Record<string, unknown> | undefined,
                });
            }
        },
    },
    development: { hmr: true, console: true },
});

console.log(`[server] pi-agent UI → http://localhost:${PORT}  (session: ${sessionId})`);
