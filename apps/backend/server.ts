// @ts-ignore - Bun HTML import (bundled automatically)
import index from "../web/index.html";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentChat,
  BaseAgentId,
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  ScheduledJob,
  TraceEvent,
} from "../../packages/core/contracts";
import { errorMessage } from "../../packages/core/errors";
import type { MultiAgentRuntime } from "../../packages/core/runtime";
import { RuntimeManager } from "../../packages/core/runtime-manager";
import type { HITLHandler, HITLRequest, HITLRequest } from "../../packages/core/tool-middleware";
import { buildHydratedUiState, getPrimaryThreadId } from "../web/ui-state";
import { verifyWebhookSignature, WebhookIdempotencyWindow } from "./kapso-webhook-utils";

const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID ?? "default";
const KAPSO_PROJECT_WEBHOOK_SECRET = process.env.KAPSO_PROJECT_WEBHOOK_SECRET ?? process.env.KAPSO_WEBHOOK_SECRET;
const KAPSO_PHONE_WEBHOOK_SECRET = process.env.KAPSO_PHONE_WEBHOOK_SECRET ?? process.env.KAPSO_WEBHOOK_SECRET;

type WsClient = import("bun").ServerWebSocket<unknown>;
const wsClients = new Set<WsClient>();
const patchedRuntimes = new WeakSet<MultiAgentRuntime>();
const delegationStarts = new Map<string, {
  orgId: string;
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  timestamp: number;
}>();
const webhookDedupe = new WebhookIdempotencyWindow();

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

function broadcast(payload: object): void {
  const text = JSON.stringify(payload);
  for (const ws of wsClients) {
    try {
      ws.send(text);
    } catch {
      // ignore closed sockets
    }
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

function getOrgIdFromRequest(req: Request): string {
  try {
    const url = new URL(req.url);
    return url.searchParams.get("orgId")?.trim() || DEFAULT_ORG_ID;
  } catch {
    return DEFAULT_ORG_ID;
  }
}

function getThreadContextFromRequest(req: Request): { orchestratorId?: string; contact?: string } {
  try {
    const url = new URL(req.url);
    const orchestratorId = url.searchParams.get("orchestratorId")?.trim() || undefined;
    const contact = url.searchParams.get("contact")?.trim() || undefined;
    return { orchestratorId, contact };
  } catch {
    return {};
  }
}

function makeDelegationKey(orgId: string, toolCallId: string): string {
  return `${orgId}:${toolCallId}`;
}

function broadcastHitlRequest(pending: PendingHitlRequest): number {
  const payload = { type: "hitl_request", reqId: pending.reqId, ...pending.request };
  let delivered = 0;
  for (const ws of wsClients) {
    if (sendWsJson(ws, payload)) delivered += 1;
  }
  console.error(
    `[hitl] request ${pending.reqId} ${pending.request.agentId}:${pending.request.toolName} delivered=${delivered} connected=${wsClients.size}`,
  );
  return delivered;
}

function startHitlTimeout(pending: PendingHitlRequest): void {
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

function markHitlSeen(reqId: string): void {
  const pending = hitlPending.get(reqId);
  if (!pending || pending.seen || pending.resolved) return;
  pending.seen = true;
  console.error(`[hitl] request ${reqId} acknowledged by UI; timeout started (${pending.request.timeout}ms)`);
  startHitlTimeout(pending);
}

function resolveHitlRequest(reqId: string, response: { approved: boolean; modifiedParams?: Record<string, unknown> }): boolean {
  const pending = hitlPending.get(reqId);
  if (!pending || pending.resolved) return false;
  pending.resolved = true;
  if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
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
    if (sendWsJson(ws, { type: "hitl_request", reqId: pending.reqId, ...pending.request })) replayed += 1;
  }
  if (replayed > 0) {
    console.error(`[hitl] replayed ${replayed} pending request(s) to newly connected UI client`);
  }
}

function createWebHitlHandler(): HITLHandler {
  return async (request) => new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID();
    const pending: PendingHitlRequest = {
      reqId,
      request,
      resolve,
      reject,
      seen: false,
      resolved: false,
    };
    hitlPending.set(reqId, pending);
    const delivered = broadcastHitlRequest(pending);
    if (delivered === 0) {
      console.error(`[hitl] request ${reqId} queued waiting for UI connection (timeout not started yet).`);
    } else {
      console.error(`[hitl] request ${reqId} delivered; waiting for UI acknowledgment before starting timeout.`);
    }
  });
}

const runtimeManager = new RuntimeManager({
  hitlHandler: createWebHitlHandler(),
  onChannelEvent: async (event: ChannelDeliveryEvent) => {
    broadcast({ type: "channel_event", event });
  },
  onCommunicationIntent: async (intent: CommunicationIntentLog) => {
    broadcast({ type: "communication_intent", intent });
  },
});

async function getRuntime(orgId: string): Promise<MultiAgentRuntime> {
  const orgRuntime = await runtimeManager.getOrgRuntime(orgId);
  const runtime = orgRuntime.runtime;
  if (!patchedRuntimes.has(runtime)) {
    patchRuntime(orgId, runtime);
    patchedRuntimes.add(runtime);
  }
  return runtime;
}

function patchRuntime(orgId: string, runtime: MultiAgentRuntime): void {
  const appendTrace = runtime.store.appendTrace.bind(runtime.store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.store as any).appendTrace = async (event: TraceEvent) => {
    await appendTrace(event);
    broadcast({ type: "trace", orgId, event });

    if (
      event.type === "tool_start" &&
      event.toolCallId &&
      (event.toolName === "delegate" || event.toolName === "delegate_task")
    ) {
      const details = event.details as Record<string, unknown> | undefined;
      const args = details?.args as Record<string, unknown> | undefined;
      const taskFromTrace = details?.task ?? args?.task;
      const start = {
        orgId,
        runId: event.runId,
        fromAgentId: event.agentId ?? "orchestrator",
        toAgentId: String(details?.agentId ?? args?.agentId ?? "unknown"),
        task: String(taskFromTrace ?? ""),
        timestamp: event.timestamp,
      };
      delegationStarts.set(makeDelegationKey(orgId, event.toolCallId), start);
      broadcast({
        type: "delegation_start",
        orgId,
        runId: start.runId,
        delegationId: event.toolCallId,
        fromAgentId: start.fromAgentId,
        toAgentId: start.toAgentId,
        task: start.task,
      });
    }

    if (event.type === "tool_end" && event.toolCallId) {
      const key = makeDelegationKey(orgId, event.toolCallId);
      const start = delegationStarts.get(key);
      if (!start) return;
      delegationStarts.delete(key);
      const details = event.details as Record<string, unknown> | undefined;
      broadcast({
        type: "delegation_end",
        orgId,
        runId: start.runId,
        delegationId: event.toolCallId,
        result: String(details?.result ?? ""),
        durationMs: event.timestamp - start.timestamp,
        status: event.status === "ok" ? "ok" : "error",
      });
    }
  };

  const appendChatRecord = runtime.store.appendChatRecord.bind(runtime.store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.store as any).appendChatRecord = async (chat: AgentChat) => {
    await appendChatRecord(chat);
    broadcast({ type: "chat_lifecycle", orgId, chat });
  };

  const appendJob = runtime.store.appendJob.bind(runtime.store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.store as any).appendJob = async (job: ScheduledJob) => {
    await appendJob(job);
    broadcast({ type: "job_lifecycle", orgId, job });
  };
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
    "/api/orgs/:orgId/orchestrators": {
      GET: async (req) => {
        try {
          const orchestrators = await runtimeManager.listOrchestrators(req.params.orgId);
          return Response.json(orchestrators);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/orgs/:orgId/orchestrators/:orchestratorId/setup-link": {
      POST: async (req) => {
        try {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const ownerNumber = typeof body.ownerNumber === "string" ? body.ownerNumber : "";
          const result = await runtimeManager.createOrchestratorWithSetupLink({
            orgId: req.params.orgId,
            orchestratorId: req.params.orchestratorId,
            ownerNumber,
          });
          await getRuntime(req.params.orgId);
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 400 });
        }
      },
    },
    "/api/kapso/webhooks/project": {
      POST: async (req) => {
        const rawBody = await req.text();
        const signature = req.headers.get("X-Webhook-Signature");
        if (!verifyWebhookSignature(rawBody, signature, KAPSO_PROJECT_WEBHOOK_SECRET)) {
          return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
        }
        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const eventName = req.headers.get("X-Webhook-Event")
          ?? (typeof payload.event === "string" ? payload.event : "");
        if (eventName === "whatsapp.phone_number.created") {
          const data = (typeof payload.data === "object" && payload.data !== null ? payload.data : payload) as Record<string, unknown>;
          const customerObj = data.customer as Record<string, unknown> | undefined;
          const customerId = typeof customerObj?.id === "string" ? customerObj.id : "";
          const phoneNumberId = typeof data.phone_number_id === "string"
            ? data.phone_number_id
            : typeof payload.phone_number_id === "string"
              ? payload.phone_number_id
              : "";
          if (customerId && phoneNumberId) {
            const updated = await runtimeManager.bindPhoneNumberByCustomer(customerId, phoneNumberId);
            if (updated) {
              await getRuntime(updated.orgId);
              broadcast({
                type: "kapso_phone_bound",
                orgId: updated.orgId,
                orchestratorId: updated.orchestratorId,
                phoneNumberId: updated.phoneNumberId,
                customerId: updated.kapsoCustomerId,
              });
            }
          }
        }
        return Response.json({ ok: true });
      },
    },
    "/api/kapso/webhooks/phone-number/:phoneNumberId": {
      POST: async (req) => {
        const rawBody = await req.text();
        const signature = req.headers.get("X-Webhook-Signature");
        if (!verifyWebhookSignature(rawBody, signature, KAPSO_PHONE_WEBHOOK_SECRET)) {
          return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
        }

        const idempotencyKey = req.headers.get("X-Idempotency-Key");
        if (webhookDedupe.markSeen(idempotencyKey)) {
          return Response.json({ ok: true, deduped: true });
        }

        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const eventName = req.headers.get("X-Webhook-Event")
          ?? (typeof payload.event === "string" ? payload.event : "");
        const phoneNumberId = req.params.phoneNumberId;
        const channel = await runtimeManager.findChannelByPhoneNumberId(phoneNumberId);
        if (!channel) {
          return Response.json({ ok: true, ignored: "phone_number_not_mapped" });
        }

        const messageObj = payload.message as Record<string, unknown> | undefined;
        const conversationObj = payload.conversation as Record<string, unknown> | undefined;
        const kapsoMessageObj = messageObj?.kapso as Record<string, unknown> | undefined;
        const contact = typeof conversationObj?.phone_number === "string"
          ? conversationObj.phone_number
          : typeof messageObj?.from === "string"
            ? messageObj.from
            : "";
        const timestamp = typeof messageObj?.timestamp === "string"
          ? Number(messageObj.timestamp) * 1000
          : Date.now();
        const textContent = typeof kapsoMessageObj?.content === "string"
          ? kapsoMessageObj.content
          : typeof (messageObj?.text as Record<string, unknown> | undefined)?.body === "string"
            ? String((messageObj?.text as Record<string, unknown>).body)
            : "";
        const messageId = typeof messageObj?.id === "string" ? messageObj.id : undefined;

        if (eventName === "whatsapp.message.received") {
          if (contact && textContent.trim()) {
            void runtimeManager.processExternalMessage({
              orgId: channel.orgId,
              orchestratorId: channel.orchestratorId,
              channel: "whatsapp",
              contact,
              content: textContent,
              messageId,
              timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
              metadata: {
                eventName,
                phoneNumberId,
                payloadVersion: req.headers.get("X-Webhook-Payload-Version") ?? "unknown",
              },
            }).catch((err) => {
              console.error("[kapso] processExternalMessage failed:", errorMessage(err));
            });
          }
          return Response.json({ ok: true, accepted: true });
        }

        const statusByEvent: Record<string, ChannelDeliveryEvent["status"] | undefined> = {
          "whatsapp.message.sent": "sent",
          "whatsapp.message.delivered": "delivered",
          "whatsapp.message.read": "read",
          "whatsapp.message.failed": "failed",
        };
        const mappedStatus = statusByEvent[eventName];
        if (mappedStatus && contact) {
          await runtimeManager.recordChannelEvent({
            eventId: crypto.randomUUID(),
            orgId: channel.orgId,
            orchestratorId: channel.orchestratorId,
            channel: "whatsapp",
            contact,
            direction: "outbound",
            status: mappedStatus,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            messageId,
            error: mappedStatus === "failed" ? JSON.stringify((kapsoMessageObj?.statuses ?? [])).slice(0, 500) : undefined,
            metadata: { eventName, phoneNumberId },
          });
        }

        return Response.json({ ok: true });
      },
    },
    "/api/agents": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(runtime.listAgents());
      },
    },
    "/api/conversations": {
      GET: async (req) => {
        try {
          const orgId = getOrgIdFromRequest(req);
          const { orchestratorId } = getThreadContextFromRequest(req);
          const conversations = await runtimeManager.listConversations(orgId, orchestratorId);
          return Response.json(conversations);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/channel-events": {
      GET: async (req) => {
        try {
          const orgId = getOrgIdFromRequest(req);
          const events = await runtimeManager.listChannelEvents(orgId);
          return Response.json(events);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/communication-intents": {
      GET: async (req) => {
        try {
          const orgId = getOrgIdFromRequest(req);
          const intents = await runtimeManager.listCommunicationIntents(orgId);
          return Response.json(intents);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/agents/:id/activity": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const agentId = req.params.id;
        const allTraces = await runtime.getTraces();
        const agentTraces = allTraces.filter((trace) => trace.agentId === agentId).slice(-100);
        const agentChats = runtime.listChats().filter((chat) => chat.agentId === agentId);
        const allJobs = runtime.scheduler?.listJobs() ?? [];
        const agentJobs = allJobs.filter((job) => job.targetAgentId === agentId || job.createdBy === agentId);
        return Response.json({ traces: agentTraces, chats: agentChats, jobs: agentJobs });
      },
    },
    "/api/chats": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(runtime.listChats());
      },
    },
    "/api/chats/:id": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const chat = runtime.getChat(req.params.id);
        return chat
          ? Response.json(chat)
          : Response.json({ error: "not found" }, { status: 404 });
      },
      DELETE: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const chat = runtime.closeChat(req.params.id);
        return chat
          ? Response.json(chat)
          : Response.json({ error: "not found" }, { status: 404 });
      },
    },
    "/api/threads": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(await runtime.listThreadIds());
      },
    },
    "/api/threads/:id": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(await runtime.getThread(decodeURIComponent(req.params.id)));
      },
    },
    "/api/traces": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(await runtime.getTraces());
      },
    },
    "/api/ui-state": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const orchestrators = await runtimeManager.listOrchestrators(orgId);
        const selectedOrchestratorId = getThreadContextFromRequest(req).orchestratorId
          ?? orchestrators[0]?.orchestratorId
          ?? runtime.getPrimaryOrchestratorId();
        const selectedContact = getThreadContextFromRequest(req).contact;
        const threadId = getPrimaryThreadId(runtime.sessionId, {
          orchestratorId: selectedOrchestratorId,
          contact: selectedContact,
        });
        const threadMessages = await runtime.getThread(threadId);
        const traces = await runtime.getTraces();
        const conversations = await runtimeManager.listConversations(orgId, selectedOrchestratorId);
        return Response.json(buildHydratedUiState({
          agents: runtime.listAgents(),
          sessionId: runtime.sessionId,
          orgId,
          selectedOrchestratorId,
          selectedContact,
          threadMessages,
          traces,
          chats: runtime.listChats(),
          jobs: runtime.scheduler?.listJobs() ?? [],
          orchestrators: orchestrators.map((orchestrator) => ({
            orchestratorId: orchestrator.orchestratorId,
            ownerNumber: orchestrator.ownerNumber,
            active: orchestrator.active,
            phoneNumberId: orchestrator.phoneNumberId,
          })),
          conversations,
        }));
      },
    },
    "/api/jobs": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        return Response.json(runtime.scheduler?.listJobs() ?? []);
      },
    },
    "/api/jobs/:id": {
      GET: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const job = runtime.scheduler?.getJob(req.params.id);
        return job ? Response.json(job) : Response.json({ error: "not found" }, { status: 404 });
      },
      DELETE: async (req) => {
        const orgId = getOrgIdFromRequest(req);
        const runtime = await getRuntime(orgId);
        const removed = runtime.scheduler?.removeJob(req.params.id);
        return removed ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
    "/chat": index,
    "/traces": index,
    "/agents": index,
    "/chats": index,
    "/jobs": index,
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      console.error(`[ws] client connected; total=${wsClients.size}`);
      void (async () => {
        try {
          const runtime = await getRuntime(DEFAULT_ORG_ID);
          ws.send(JSON.stringify({
            type: "agents",
            agents: runtime.listAgents(),
            sessionId: runtime.sessionId,
            orgId: DEFAULT_ORG_ID,
          }));
          replayPendingHitlToClient(ws);
        } catch (err) {
          ws.send(JSON.stringify({
            type: "stream_error",
            runId: "",
            error: errorMessage(err),
          }));
        }
      })();
    },
    close(ws) {
      wsClients.delete(ws);
      console.error(`[ws] client disconnected; total=${wsClients.size}`);
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
        const orgId = typeof msg.orgId === "string" && msg.orgId.trim() ? msg.orgId.trim() : DEFAULT_ORG_ID;
        const orchestratorId = typeof msg.orchestratorId === "string" && msg.orchestratorId.trim()
          ? msg.orchestratorId.trim()
          : "orchestrator";
        const contact = typeof msg.contact === "string" && msg.contact.trim() ? msg.contact.trim() : undefined;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (!content.trim()) return;

        const runId = crypto.randomUUID();
        ws.send(JSON.stringify({ type: "chat_sending", runId, orgId, orchestratorId, contact }));

        runtimeManager.chatFromUi({
          orgId,
          orchestratorId,
          contact,
          content,
          onAgentEvent: (event: AgentEvent) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              const delta = sanitizeThoughtPrefix(event.assistantMessageEvent.delta);
              if (!delta) return;
              ws.send(JSON.stringify({ type: "stream_delta", runId, orgId, delta }));
            } else if (event.type === "tool_execution_start") {
              const args = event.args as Record<string, unknown>;
              let label = `→ ${event.toolName}`;
              if (event.toolName === "delegate" || event.toolName === "delegate_task") {
                label = `→ delegate → ${args.agentId}: ${String(args.task ?? "").slice(0, 80)}`;
              } else if (event.toolName === "get_chat_result" || event.toolName === "get_chat_status") {
                label = `→ ${event.toolName} → ${String(args.chatId ?? "")}`;
              }
              ws.send(JSON.stringify({ type: "stream_status", runId, orgId, text: label }));
            }
          },
        })
          .then((output) => {
            ws.send(JSON.stringify({
              type: "stream_end",
              runId,
              orgId,
              answer: sanitizeThoughtPrefix(output.answer),
              durationMs: output.durationMs,
            }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({
              type: "stream_error",
              runId,
              orgId,
              error: errorMessage(err),
            }));
          });
      } else if (msg.type === "close_chat") {
        const orgId = typeof msg.orgId === "string" && msg.orgId.trim() ? msg.orgId.trim() : DEFAULT_ORG_ID;
        void getRuntime(orgId).then((runtime) => {
          runtime.closeChat(msg.chatId as string);
        });
      } else if (msg.type === "hitl_seen") {
        markHitlSeen(msg.reqId as string);
      } else if (msg.type === "hitl_response") {
        resolveHitlRequest(msg.reqId as string, {
          approved: msg.approved as boolean,
          modifiedParams: msg.modifiedParams as Record<string, unknown> | undefined,
        });
      }
    },
  },
  development: { hmr: true, console: true },
});

console.log(`[server] pi-agent UI -> http://localhost:${PORT} (default org: ${DEFAULT_ORG_ID})`);
