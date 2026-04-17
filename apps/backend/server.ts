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
import { normalizePhoneNumber } from "../../packages/core/phone-utils";
import type { MultiAgentRuntime } from "../../packages/core/runtime";
import { RuntimeManager } from "../../packages/core/runtime-manager";
import { createSupabaseAdminClient, readSupabaseAdminConfigFromEnv } from "../../packages/core/supabase-client";
import type { HITLHandler, HITLRequest } from "../../packages/core/tool-middleware";
import { buildHydratedUiState, getPrimaryThreadId } from "../web/ui-state";
import { verifyWebhookSignature, WebhookIdempotencyWindow } from "./kapso-webhook-utils";

const KAPSO_WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET;
const KAPSO_PROJECT_WEBHOOK_SECRET = process.env.KAPSO_PROJECT_WEBHOOK_SECRET ?? KAPSO_WEBHOOK_SECRET;
const KAPSO_PHONE_WEBHOOK_SECRET = process.env.KAPSO_PHONE_WEBHOOK_SECRET ?? KAPSO_WEBHOOK_SECRET;
const KAPSO_BOOTSTRAP_ORCHESTRATOR_ID = process.env.KAPSO_BOOTSTRAP_ORCHESTRATOR_ID?.trim() || "main";
const KAPSO_BOOTSTRAP_OWNER_NUMBER = process.env.KAPSO_BOOTSTRAP_OWNER_NUMBER;
const KAPSO_BOOTSTRAP_CUSTOMER_ID = process.env.KAPSO_BOOTSTRAP_CUSTOMER_ID;
const KAPSO_BOOTSTRAP_PHONE_NUMBER_ID = process.env.KAPSO_BOOTSTRAP_PHONE_NUMBER_ID;
const KAPSO_BOOTSTRAP_ACTIVE = process.env.KAPSO_BOOTSTRAP_ACTIVE;
const SUPABASE_PUBLIC_URL = process.env.SUPABASE_URL?.trim()
  ?? process.env.VITE_SUPABASE_URL?.trim()
  ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
  ?? process.env.SUPABASE_ANON_KEY?.trim()
  ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  ?? "";
const SUPABASE_ADMIN_CONFIG = readSupabaseAdminConfigFromEnv();
if (!SUPABASE_ADMIN_CONFIG) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY (fallback: SUPABASE_SERVICE_ROLE_KEY) for backend auth.");
}
const supabaseAdmin = createSupabaseAdminClient(SUPABASE_ADMIN_CONFIG);

interface WsSessionData {
  orgId: string;
  userId: string;
}

type WsClient = import("bun").ServerWebSocket<unknown>;
const wsClients = new Map<WsClient, WsSessionData>();
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
/** Maps normalized WhatsApp contact number â†’ FIFO queue of pending HITL reqIds for that contact */
const hitlContactIndex = new Map<string, string[]>();

function sendWsJson(ws: WsClient, payload: object): boolean {
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function wsSessionForClient(ws: WsClient): WsSessionData | undefined {
  return wsClients.get(ws) ?? (ws.data as WsSessionData | undefined);
}

function broadcastToOrg(orgId: string, payload: object): number {
  const text = JSON.stringify(payload);
  let delivered = 0;
  for (const [ws, session] of wsClients.entries()) {
    if (session.orgId !== orgId) continue;
    try {
      ws.send(text);
      delivered += 1;
    } catch {
      // ignore closed sockets
    }
  }
  return delivered;
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

function truncateStatusText(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function extractToolErrorText(result: unknown): string {
  if (!result || typeof result !== "object") return "Tool execution failed.";
  const typed = result as { content?: unknown };
  if (!Array.isArray(typed.content)) return "Tool execution failed.";
  for (const block of typed.content) {
    if (typeof block !== "object" || block === null) continue;
    const maybeText = block as { type?: unknown; text?: unknown };
    if (maybeText.type === "text" && typeof maybeText.text === "string" && maybeText.text.trim()) {
      return truncateStatusText(maybeText.text.trim());
    }
  }
  return "Tool execution failed.";
}

function isUuid(value?: string | null): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function getBearerToken(req: Request, opts?: { allowQueryToken?: boolean }): string | undefined {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "").trim() || undefined;
  }
  if (!opts?.allowQueryToken) return undefined;
  try {
    const url = new URL(req.url);
    return url.searchParams.get("token")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function unauthorizedResponse(message = "unauthorized"): Response {
  return Response.json({ error: message }, { status: 401 });
}

function forbiddenResponse(message = "forbidden"): Response {
  return Response.json({ error: message }, { status: 403 });
}

async function authenticateRequest(
  req: Request,
  opts?: { allowQueryToken?: boolean },
): Promise<{ userId: string; token: string } | Response> {
  const token = getBearerToken(req, opts);
  if (!token) return unauthorizedResponse("missing_bearer_token");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.id) return unauthorizedResponse("invalid_bearer_token");
  return { userId: data.user.id, token };
}

async function authorizeOrgRequest(
  req: Request,
  explicitOrgId?: string,
  opts?: { allowQueryToken?: boolean },
): Promise<{ userId: string; token: string; orgId: string } | Response> {
  const auth = await authenticateRequest(req, opts);
  if (auth instanceof Response) return auth;
  let requestedOrgId = explicitOrgId?.trim() || undefined;
  let explicitOrgScope = Boolean(requestedOrgId);
  if (!requestedOrgId) {
    try {
      const url = new URL(req.url);
      const queryOrgId = url.searchParams.get("orgId")?.trim();
      if (queryOrgId) {
        requestedOrgId = queryOrgId;
        explicitOrgScope = true;
      }
    } catch {
      // Ignore URL parse failures and continue with defaults.
    }
  }
  if (requestedOrgId && !isUuid(requestedOrgId)) {
    if (explicitOrgScope) return forbiddenResponse("invalid_org_id");
    requestedOrgId = undefined;
  }

  const memberships = await runtimeManager.listUserOrgIds(auth.userId);
  if (!requestedOrgId) {
    requestedOrgId = memberships[0];
  }
  if (!requestedOrgId) return forbiddenResponse("missing_org_id");
  const allowed = await runtimeManager.isUserMemberOfOrg(auth.userId, requestedOrgId);
  if (!allowed) {
    if (explicitOrgScope) return forbiddenResponse("org_membership_required");
    const fallbackOrgId = memberships[0];
    if (!fallbackOrgId) return forbiddenResponse("org_membership_required");
    requestedOrgId = fallbackOrgId;
  }
  return { ...auth, orgId: requestedOrgId };
}

function getThreadContextFromRequest(req: Request): { orchestratorId?: string; contact?: string } {
  try {
    const url = new URL(req.url);
    const orchestratorId = url.searchParams.get("orchestratorId")?.trim() || undefined;
    const rawContact = url.searchParams.get("contact")?.trim() || undefined;
    const contact = rawContact ? normalizePhoneNumber(rawContact) : undefined;
    return { orchestratorId, contact };
  } catch {
    return {};
  }
}

function makeDelegationKey(orgId: string, toolCallId: string): string {
  return `${orgId}:${toolCallId}`;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function broadcastHitlRequest(pending: PendingHitlRequest): number {
  const payload = { type: "hitl_request", reqId: pending.reqId, ...pending.request };
  const targetOrgId = pending.request.orgId?.trim();
  const delivered = targetOrgId
    ? broadcastToOrg(targetOrgId, payload)
    : (() => {
      let count = 0;
      for (const ws of wsClients.keys()) {
        if (sendWsJson(ws, payload)) count += 1;
      }
      return count;
    })();
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
    const payload = {
      type: "hitl_expired",
      reqId: pending.reqId,
      agentId: pending.request.agentId,
      toolName: pending.request.toolName,
      timeout: pending.request.timeout,
    };
    const targetOrgId = pending.request.orgId?.trim();
    if (targetOrgId) {
      broadcastToOrg(targetOrgId, payload);
    } else {
      for (const ws of wsClients.keys()) {
        sendWsJson(ws, payload);
      }
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
  // Clean up WhatsApp contact queue
  if (pending.request.contact) {
    const queue = hitlContactIndex.get(pending.request.contact);
    if (queue) {
      const idx = queue.indexOf(reqId);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) hitlContactIndex.delete(pending.request.contact);
    }
  }
  console.error(`[hitl] request ${reqId} response approved=${response.approved}`);
  pending.resolve(response);
  const resolvedPayload = { type: "hitl_resolved", reqId, approved: response.approved };
  const targetOrgId = pending.request.orgId?.trim();
  if (targetOrgId) {
    broadcastToOrg(targetOrgId, resolvedPayload);
  } else {
    for (const ws of wsClients.keys()) {
      sendWsJson(ws, resolvedPayload);
    }
  }
  return true;
}

function replayPendingHitlToClient(ws: WsClient, orgId: string): void {
  let replayed = 0;
  for (const pending of hitlPending.values()) {
    if (pending.request.orgId && pending.request.orgId !== orgId) continue;
    if (sendWsJson(ws, { type: "hitl_request", reqId: pending.reqId, ...pending.request })) replayed += 1;
  }
  if (replayed > 0) {
    console.error(`[hitl] replayed ${replayed} pending request(s) to newly connected UI client`);
  }
}

/** Friendly agent display name (strips internal prefixes like "orchestrator:") */
function agentDisplayName(agentId: string): string {
  if (agentId.startsWith("orchestrator:") || agentId === "orchestrator") return "Dithie";
  return agentId.replace(/:.*$/, "");
}

/** Human-readable description of what a HITL tool call is trying to do */
function hitlActionDescription(toolName: string, params: Record<string, unknown>): string {
  const p = params as Record<string, string>;
  switch (toolName) {
    case "run_command":
      return `Ejecutar comando en terminal:\n\`${String(p.command ?? "").slice(0, 200)}\``;
    case "read_file":
      return `Leer archivo: \`${p.path ?? p.filePath ?? ""}\``;
    case "write_file":
    case "edit_file":
      return `${toolName === "edit_file" ? "Editar" : "Escribir"} archivo: \`${p.path ?? p.filePath ?? ""}\``;
    case "list_directory":
      return `Listar directorio: \`${p.path ?? "."}\``;
    case "search_code":
      return `Buscar en cÃ³digo: \`${p.query ?? p.pattern ?? ""}\``;
    case "delegate":
    case "delegate_task": {
      const task = String(p.task ?? "").slice(0, 150);
      return `Delegar tarea al agente *${p.agentId ?? "?"}*:\n_${task}${task.length === 150 ? "â€¦" : ""}_`;
    }
    case "browse_url":
      return `Abrir URL: ${p.url ?? ""}`;
    case "interact_page":
      return `Automatizar navegador con la tarea:\n_${String(p.task ?? "").slice(0, 150)}_`;
    case "search_web":
      return `Buscar en la web: _${p.query ?? ""}_`;
    case "schedule_task": {
      const sched = p.schedule ?? p.cron ?? "";
      const task = String(p.task ?? "").slice(0, 100);
      return `Programar tarea (${sched}):\n_${task}_`;
    }
    case "cancel_scheduled_job":
      return `Cancelar tarea programada: \`${p.jobId ?? ""}\``;
    case "gmail_send":
    case "gmail_draft": {
      const action = toolName === "gmail_send" ? "Enviar email" : "Guardar borrador";
      return `${action} a *${p.to ?? "?"}*: _${String(p.subject ?? "").slice(0, 80)}_`;
    }
    case "calendar_create":
    case "calendar_update":
      return `${toolName === "calendar_create" ? "Crear" : "Actualizar"} evento: _${String(p.title ?? p.summary ?? "").slice(0, 80)}_`;
    case "calendar_delete":
      return `Eliminar evento del calendario: \`${p.eventId ?? ""}\``;
    case "write_gsheet":
    case "create_gsheet":
      return `${toolName === "create_gsheet" ? "Crear" : "Escribir en"} hoja de cÃ¡lculo${p.title ? `: _${p.title}_` : ""}`;
    case "write_gdoc":
    case "create_gdoc":
      return `${toolName === "create_gdoc" ? "Crear" : "Escribir en"} Google Doc${p.title ? `: _${p.title}_` : ""}`;
    case "git_commit":
      return `Commit git: _${String(p.message ?? "").slice(0, 100)}_`;
    case "git_push":
      return `Push git al remoto${p.branch ? ` (${p.branch})` : ""}`;
    case "github_create_pr":
      return `Crear Pull Request: _${String(p.title ?? "").slice(0, 80)}_`;
    case "github_merge_pr":
      return `Hacer merge del PR #${p.prNumber ?? p.pullNumber ?? "?"}`;
    case "request_credentials":
      return `Solicitar credenciales para: _${p.domain ?? p.service ?? ""}_`;
    default:
      return `Usar herramienta \`${toolName}\``;
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

    // WhatsApp channel: send approval message to the contact and start timeout immediately
    if (request.channel === "whatsapp" && request.contact && request.orgId && request.orchestratorId) {
      const existing = hitlContactIndex.get(request.contact);
      if (existing) {
        existing.push(reqId);
      } else {
        hitlContactIndex.set(request.contact, [reqId]);
      }
      const shortRef = reqId.slice(0, 8);
      const waBody = [
        `ðŸ”” *AprobaciÃ³n requerida*`,
        ``,
        hitlActionDescription(request.toolName, request.params),
        ``,
        `_Solicitado por ${agentDisplayName(request.agentId)}_`,
        ``,
        `Responde *si* para aprobar o *no* para rechazar.`,
        `*si todo* para aprobar todo`,
      ].join("\n");
      runtimeManager.sendChannelMessage(request.orgId, request.orchestratorId, request.contact, waBody)
        .then(() => {
          console.error(`[hitl] WA request ${reqId} sent to ${request.contact}; starting timeout (${request.timeout}ms)`);
          startHitlTimeout(pending);
        })
        .catch((err) => {
          console.error(`[hitl] WA request ${reqId} send failed: ${errorMessage(err)}; starting timeout anyway`);
          startHitlTimeout(pending);
        });
    }

    // Always broadcast to UI WebSocket clients (dual-channel: either WA or UI can resolve)
    const delivered = broadcastHitlRequest(pending);
    if (delivered === 0 && request.channel !== "whatsapp") {
      console.error(`[hitl] request ${reqId} queued waiting for UI connection (timeout not started yet).`);
    } else if (delivered > 0) {
      console.error(`[hitl] request ${reqId} delivered to UI; waiting for acknowledgment before starting timeout.`);
    }
  });
}

const runtimeManager = new RuntimeManager({
  hitlHandler: createWebHitlHandler(),
  onChannelEvent: async (event: ChannelDeliveryEvent) => {
    broadcastToOrg(event.orgId, { type: "channel_event", event });
  },
  onCommunicationIntent: async (intent: CommunicationIntentLog) => {
    broadcastToOrg(intent.orgId, { type: "communication_intent", intent });
  },
});

async function resolveKapsoWebhookSecret(
  key: "KAPSO_PROJECT_WEBHOOK_SECRET" | "KAPSO_PHONE_WEBHOOK_SECRET",
  context?: { orgId?: string; userId?: string; orchestratorId?: string },
): Promise<string | undefined> {
  const scoped = await runtimeManager.resolveEnvOverride(key, context);
  if (typeof scoped === "string" && scoped.trim().length > 0) return scoped.trim();

  const generic = await runtimeManager.resolveEnvOverride("KAPSO_WEBHOOK_SECRET", context);
  if (typeof generic === "string" && generic.trim().length > 0) return generic.trim();

  return key === "KAPSO_PROJECT_WEBHOOK_SECRET"
    ? KAPSO_PROJECT_WEBHOOK_SECRET
    : KAPSO_PHONE_WEBHOOK_SECRET;
}

async function getRuntime(orgId: string): Promise<MultiAgentRuntime> {
  const orgRuntime = await runtimeManager.getOrgRuntime(orgId);
  const runtime = orgRuntime.runtime;
  if (!patchedRuntimes.has(runtime)) {
    patchRuntime(orgId, runtime);
    patchedRuntimes.add(runtime);
  }
  return runtime;
}

async function applyKapsoChannelBootstrapFromEnv(): Promise<void> {
  const ownerNumber = KAPSO_BOOTSTRAP_OWNER_NUMBER?.trim();
  const kapsoCustomerId = KAPSO_BOOTSTRAP_CUSTOMER_ID?.trim();
  if (!ownerNumber || !kapsoCustomerId) return;

  try {
    const rank = (role: string) => (role === "owner" ? 0 : role === "admin" ? 1 : 2);
    let resolvedOrgId: string | undefined;
    let resolvedUserId: string | undefined;
    const existingByCustomer = await runtimeManager.findChannelByKapsoCustomerId(kapsoCustomerId);
    if (!resolvedOrgId && existingByCustomer) {
      resolvedOrgId = existingByCustomer.orgId;
      resolvedUserId = existingByCustomer.userId;
    }
    if (resolvedOrgId && !resolvedUserId) {
      const { data: members, error: memberErr } = await supabaseAdmin
        .from("org_memberships")
        .select("user_id, role, created_at")
        .eq("org_id", resolvedOrgId)
        .order("created_at", { ascending: true });
      if (memberErr) {
        throw new Error(`Failed to resolve bootstrap user for org '${resolvedOrgId}': ${memberErr.message}`);
      }
      const preferred = (members ?? [])
        .map((row) => row as { user_id: string; role: string })
        .sort((a, b) => rank(a.role) - rank(b.role))[0];
      resolvedUserId = preferred?.user_id;
    }
    if (!resolvedOrgId || !resolvedUserId) {
      const { data: members, error: memberErr } = await supabaseAdmin
        .from("org_memberships")
        .select("org_id, user_id, role, created_at")
        .order("created_at", { ascending: true });
      if (memberErr) {
        throw new Error(`Failed to resolve bootstrap org/user from memberships: ${memberErr.message}`);
      }
      const preferred = (members ?? [])
        .map((row) => row as { org_id: string; user_id: string; role: string })
        .sort((a, b) => rank(a.role) - rank(b.role))[0];
      if (!preferred?.org_id || !preferred?.user_id) {
        throw new Error("No org_memberships found to resolve bootstrap org/user.");
      }
      resolvedOrgId = preferred.org_id;
      resolvedUserId = preferred.user_id;
    }
    const config = await runtimeManager.upsertOrchestratorChannel({
      orgId: resolvedOrgId,
      userId: resolvedUserId,
      orchestratorId: KAPSO_BOOTSTRAP_ORCHESTRATOR_ID,
      ownerNumber,
      kapsoCustomerId,
      phoneNumberId: KAPSO_BOOTSTRAP_PHONE_NUMBER_ID?.trim() || undefined,
      active: parseOptionalBoolean(KAPSO_BOOTSTRAP_ACTIVE),
    });
    await getRuntime(config.orgId);
    console.error(
      `[kapso] bootstrap channel upserted org=${config.orgId} orchestrator=${config.orchestratorId} customer=${config.kapsoCustomerId} phone=${config.phoneNumberId ?? "none"}`,
    );
  } catch (err) {
    console.error("[kapso] bootstrap channel failed:", errorMessage(err));
  }
}

function patchRuntime(orgId: string, runtime: MultiAgentRuntime): void {
  const appendTrace = runtime.store.appendTrace.bind(runtime.store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.store as any).appendTrace = async (event: TraceEvent) => {
    await appendTrace(event);
    broadcastToOrg(orgId, { type: "trace", orgId, event });

    if (
      event.type === "tool_start" &&
      event.toolCallId &&
      (event.toolName === "delegate" || event.toolName === "delegate_task")
    ) {
      const details = event.details as Record<string, unknown> | undefined;
      // Each delegate tool call emits two tool_start traces: one for the
      // permission check (no "phase") and one for execution (phase: "execution").
      // Only broadcast delegation_start on the execution trace to avoid duplicates.
      const isExecutionPhase = (details as Record<string, unknown> | undefined)?.phase === "execution";
      if (!isExecutionPhase) return;

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
      broadcastToOrg(orgId, {
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
      broadcastToOrg(orgId, {
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
    broadcastToOrg(orgId, { type: "chat_lifecycle", orgId, chat });
  };

  const appendJob = runtime.store.appendJob.bind(runtime.store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.store as any).appendJob = async (job: ScheduledJob) => {
    await appendJob(job);
    broadcastToOrg(orgId, { type: "job_lifecycle", orgId, job });
  };
}

const PORT = 3000;
await applyKapsoChannelBootstrapFromEnv();

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
    "/ws": async (req, server) => {
      const auth = await authorizeOrgRequest(req, undefined, { allowQueryToken: true });
      if (auth instanceof Response) return auth;
      if ((server as any).upgrade(req, { data: { orgId: auth.orgId, userId: auth.userId } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
    "/api/auth/config": {
      GET: async () => Response.json({
        enabled: Boolean(SUPABASE_PUBLIC_URL && SUPABASE_PUBLISHABLE_KEY),
        supabaseUrl: SUPABASE_PUBLIC_URL || undefined,
        supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY || undefined,
      }),
    },
    "/api/orgs/:orgId/orchestrators": {
      GET: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req, req.params.orgId);
          if (auth instanceof Response) return auth;
          const orchestrators = await runtimeManager.listOrchestrators(auth.orgId);
          return Response.json(orchestrators);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/orgs/:orgId/orchestrators/:orchestratorId/setup-link": {
      POST: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req, req.params.orgId);
          if (auth instanceof Response) return auth;
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const ownerNumber = typeof body.ownerNumber === "string" ? body.ownerNumber : "";
          const result = await runtimeManager.createOrchestratorWithSetupLink({
            orgId: auth.orgId,
            userId: auth.userId,
            orchestratorId: req.params.orchestratorId,
            ownerNumber,
          });
          await getRuntime(auth.orgId);
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 400 });
        }
      },
    },
    "/api/orgs/:orgId/orchestrators/:orchestratorId/channel": {
      POST: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req, req.params.orgId);
          if (auth instanceof Response) return auth;
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const requestedUserId = typeof body.userId === "string" ? body.userId.trim() : "";
          const channelUserId = requestedUserId || auth.userId;
          if (!channelUserId) {
            return Response.json({ error: "missing_user_id" }, { status: 400 });
          }
          if (!await runtimeManager.isUserMemberOfOrg(channelUserId, auth.orgId)) {
            return Response.json({ error: "user_not_member_of_org" }, { status: 403 });
          }
          const ownerNumber = typeof body.ownerNumber === "string" ? body.ownerNumber : "";
          const kapsoCustomerId = typeof body.kapsoCustomerId === "string" ? body.kapsoCustomerId : "";
          const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId : undefined;
          const active = typeof body.active === "boolean" ? body.active : undefined;
          const channel = await runtimeManager.upsertOrchestratorChannel({
            orgId: auth.orgId,
            userId: channelUserId,
            orchestratorId: req.params.orchestratorId,
            ownerNumber,
            kapsoCustomerId,
            phoneNumberId,
            active,
          });
          await getRuntime(auth.orgId);
          return Response.json(channel);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 400 });
        }
      },
    },
    "/api/kapso/webhooks/project": {
      POST: async (req) => {
        const rawBody = await req.text();
        const signature = req.headers.get("X-Webhook-Signature");
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
        }

        const data = (typeof payload.data === "object" && payload.data !== null ? payload.data : payload) as Record<string, unknown>;
        const customerObj = data.customer as Record<string, unknown> | undefined;
        const customerId = typeof customerObj?.id === "string" ? customerObj.id : "";
        const channel = customerId
          ? await runtimeManager.findChannelByKapsoCustomerId(customerId)
          : undefined;
        const secret = await resolveKapsoWebhookSecret("KAPSO_PROJECT_WEBHOOK_SECRET", channel
          ? { orgId: channel.orgId, userId: channel.userId, orchestratorId: channel.orchestratorId }
          : undefined);

        if (!verifyWebhookSignature(rawBody, signature, secret)) {
          return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
        }

        const eventName = req.headers.get("X-Webhook-Event")
          ?? (typeof payload.event === "string" ? payload.event : "");
        if (eventName === "whatsapp.phone_number.created") {
          const phoneNumberId = typeof data.phone_number_id === "string"
            ? data.phone_number_id
            : typeof payload.phone_number_id === "string"
              ? payload.phone_number_id
              : "";
          if (customerId && phoneNumberId) {
            const updated = await runtimeManager.bindPhoneNumberByCustomer(customerId, phoneNumberId);
            if (updated) {
              await getRuntime(updated.orgId);
              broadcastToOrg(updated.orgId, {
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
        const phoneNumberId = req.params.phoneNumberId;
        const channel = await runtimeManager.findChannelByPhoneNumberId(phoneNumberId);
        const secret = await resolveKapsoWebhookSecret("KAPSO_PHONE_WEBHOOK_SECRET", channel
          ? { orgId: channel.orgId, userId: channel.userId, orchestratorId: channel.orchestratorId }
          : undefined);
        if (!verifyWebhookSignature(rawBody, signature, secret)) {
          return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
        }

        const idempotencyKey = req.headers.get("X-Idempotency-Key");
        if (webhookDedupe.markSeen(idempotencyKey)) {
          return Response.json({ ok: true, deduped: true });
        }

        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const eventName = req.headers.get("X-Webhook-Event")
          ?? (typeof payload.event === "string" ? payload.event : "");
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
            // Check if this message resolves a pending HITL before routing to the agent
            const normalizedContact = contact.replace(/[^\d+]/g, "").trim();
            const hitlQueue = hitlContactIndex.get(normalizedContact);
            if (hitlQueue && hitlQueue.length > 0) {
              const trimmed = textContent.trim().toLowerCase();
              const approveAll = ["si todo", "sÃ­ todo", "yes all", "aprobar todo", "all"].includes(trimmed);
              const denyAll = ["no todo", "rechazar todo", "deny all"].includes(trimmed);
              if (approveAll || denyAll) {
                // Resolve every pending HITL for this contact at once
                const ids = [...hitlQueue];
                for (const reqId of ids) resolveHitlRequest(reqId, { approved: approveAll });
                console.error(`[hitl] WA bulk reply from ${normalizedContact}: approved=${approveAll} resolved=${ids.length}`);
                return Response.json({ ok: true, hitl_resolved: true, approved: approveAll, resolved: ids.length });
              }
              const approved = ["si", "sÃ­", "s", "yes", "y", "ok", "aprobar"].includes(trimmed);
              const denied = ["no", "n", "nope", "rechazar", "denegar"].includes(trimmed);
              if (approved || denied) {
                // Resolve the oldest pending HITL for this contact (FIFO)
                const pendingHitlReqId = hitlQueue[0]!;
                resolveHitlRequest(pendingHitlReqId, { approved });
                console.error(`[hitl] WA reply from ${normalizedContact}: approved=${approved} reqId=${pendingHitlReqId} remaining=${hitlQueue.length}`);
                return Response.json({ ok: true, hitl_resolved: true, approved });
              }
            }

            // Signal UI that a WA conversation is now active so the chat feed
            // adopts this (orgId, orchestratorId, contact) tuple before the
            // channel_event messages arrive.
            const waRunId = messageId ?? crypto.randomUUID();
            const waStart = Date.now();
            broadcastToOrg(channel.orgId, {
              type: "chat_sending",
              runId: waRunId,
              orgId: channel.orgId,
              orchestratorId: channel.orchestratorId,
              contact: normalizedContact,
            });

            runtimeManager.processExternalMessage({
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
            }).then(() => {
              // Answer is already in the UI via channel_event outbound "sent".
              // Send stream_end with empty answer to reset the streaming indicator.
              broadcastToOrg(channel.orgId, {
                type: "stream_end",
                runId: waRunId,
                orgId: channel.orgId,
                answer: "",
                durationMs: Date.now() - waStart,
              });
            }).catch((err) => {
              console.error("[kapso] processExternalMessage failed:", errorMessage(err));
              broadcastToOrg(channel.orgId, {
                type: "stream_error",
                runId: waRunId,
                orgId: channel.orgId,
                error: errorMessage(err),
              });
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
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(runtime.listAgents());
      },
    },
    "/api/conversations": {
      GET: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req);
          if (auth instanceof Response) return auth;
          const { orchestratorId } = getThreadContextFromRequest(req);
          const conversations = await runtimeManager.listConversations(auth.orgId, orchestratorId);
          return Response.json(conversations);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/channel-events": {
      GET: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req);
          if (auth instanceof Response) return auth;
          const events = await runtimeManager.listChannelEvents(auth.orgId);
          return Response.json(events);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/communication-intents": {
      GET: async (req) => {
        try {
          const auth = await authorizeOrgRequest(req);
          if (auth instanceof Response) return auth;
          const intents = await runtimeManager.listCommunicationIntents(auth.orgId);
          return Response.json(intents);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      },
    },
    "/api/agents/:id/activity": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
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
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(runtime.listChats());
      },
    },
    "/api/chats/:id": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        const chat = runtime.getChat(req.params.id);
        return chat
          ? Response.json(chat)
          : Response.json({ error: "not found" }, { status: 404 });
      },
      DELETE: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        const chat = runtime.closeChat(req.params.id);
        return chat
          ? Response.json(chat)
          : Response.json({ error: "not found" }, { status: 404 });
      },
    },
    "/api/threads": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(await runtime.listThreadIds());
      },
    },
    "/api/threads/:id": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(await runtime.getThread(decodeURIComponent(req.params.id)));
      },
    },
    "/api/traces": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(await runtime.getTraces());
      },
    },
    "/api/ui-state": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        const orchestrators = await runtimeManager.listOrchestrators(auth.orgId);
        const selectedOrchestratorId = getThreadContextFromRequest(req).orchestratorId
          ?? orchestrators[0]?.orchestratorId
          ?? runtime.getPrimaryOrchestratorId();
        const selectedContact = getThreadContextFromRequest(req).contact;
        const threadId = getPrimaryThreadId(runtime.sessionId, {
          orchestratorId: selectedOrchestratorId,
          contact: selectedContact,
        });
        const threadMessages = await runtime.getThread(threadId);
        const threadRunIds = new Set(threadMessages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)));
        const traces = threadRunIds.size === 0
          ? []
          : (await runtime.getTraces()).filter((trace) => threadRunIds.has(trace.runId));
        const conversations = await runtimeManager.listConversations(auth.orgId, selectedOrchestratorId);
        return Response.json(buildHydratedUiState({
          agents: runtime.listAgents(),
          sessionId: runtime.sessionId,
          orgId: auth.orgId,
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
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        return Response.json(runtime.scheduler?.listJobs() ?? []);
      },
    },
    "/api/jobs/:id": {
      GET: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        const job = runtime.scheduler?.getJob(req.params.id);
        return job ? Response.json(job) : Response.json({ error: "not found" }, { status: 404 });
      },
      DELETE: async (req) => {
        const auth = await authorizeOrgRequest(req);
        if (auth instanceof Response) return auth;
        const runtime = await getRuntime(auth.orgId);
        const removed = runtime.scheduler?.removeJob(req.params.id);
        return removed ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
    "/chat": index,
    "/login": index,
    "/traces": index,
    "/agents": index,
    "/chats": index,
    "/jobs": index,
  },
  websocket: {
    open(ws) {
      const session = wsSessionForClient(ws);
      if (!session?.orgId || !session.userId) {
        ws.close(1008, "unauthorized");
        return;
      }
      wsClients.set(ws, session);
      console.error(`[ws] client connected; org=${session.orgId} user=${session.userId} total=${wsClients.size}`);
      void (async () => {
        try {
          const runtime = await getRuntime(session.orgId);
          ws.send(JSON.stringify({
            type: "agents",
            agents: runtime.listAgents(),
            sessionId: runtime.sessionId,
            orgId: session.orgId,
          }));
          replayPendingHitlToClient(ws, session.orgId);
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
      const session = wsSessionForClient(ws);
      wsClients.delete(ws);
      if (session) {
        console.error(`[ws] client disconnected; org=${session.orgId} user=${session.userId} total=${wsClients.size}`);
      } else {
        console.error(`[ws] client disconnected; total=${wsClients.size}`);
      }
    },
    message(ws, data) {
      const session = wsSessionForClient(ws);
      if (!session) {
        ws.close(1008, "unauthorized");
        return;
      }
      const text = typeof data === "string" ? data : data.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "chat") {
        const requestedOrgId = typeof msg.orgId === "string" && msg.orgId.trim() ? msg.orgId.trim() : session.orgId;
        if (requestedOrgId !== session.orgId) {
          ws.send(JSON.stringify({
            type: "stream_error",
            runId: "",
            orgId: session.orgId,
            error: "forbidden_org_scope",
          }));
          return;
        }
        const orgId = session.orgId;
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
          userId: session.userId,
          orchestratorId,
          contact,
          content,
          onAgentEvent: (event: AgentEvent) => {
            if (event.type !== "message_update") return;

            if (event.assistantMessageEvent.type === "text_delta") {
              const delta = sanitizeThoughtPrefix(event.assistantMessageEvent.delta);
              if (!delta) return;
              ws.send(JSON.stringify({ type: "stream_delta", runId, orgId, delta }));
              return;
            }

            if (event.assistantMessageEvent.type === "thinking_start") {
              ws.send(JSON.stringify({ type: "stream_thinking_start", runId, orgId }));
              return;
            }

            if (event.assistantMessageEvent.type === "thinking_delta") {
              if (!event.assistantMessageEvent.delta) return;
              ws.send(JSON.stringify({
                type: "stream_thinking_delta",
                runId,
                orgId,
                delta: event.assistantMessageEvent.delta,
              }));
              return;
            }

            if (event.assistantMessageEvent.type === "thinking_end") {
              ws.send(JSON.stringify({
                type: "stream_thinking_end",
                runId,
                orgId,
                content: event.assistantMessageEvent.content,
              }));
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
        void getRuntime(session.orgId).then((runtime) => {
          runtime.closeChat(msg.chatId as string);
        });
      } else if (msg.type === "hitl_seen") {
        const reqId = String(msg.reqId ?? "");
        const pending = hitlPending.get(reqId);
        if (!pending) return;
        if (pending.request.orgId && pending.request.orgId !== session.orgId) return;
        markHitlSeen(reqId);
      } else if (msg.type === "hitl_response") {
        const reqId = String(msg.reqId ?? "");
        const pending = hitlPending.get(reqId);
        if (!pending) return;
        if (pending.request.orgId && pending.request.orgId !== session.orgId) return;
        resolveHitlRequest(reqId, {
          approved: msg.approved as boolean,
          modifiedParams: msg.modifiedParams as Record<string, unknown> | undefined,
        });
      }
    },
  },
  development: { hmr: true, console: true },
});

console.log(
  `[server] pi-agent UI -> http://localhost:${PORT} (default org policy: supabase-membership)`,
);


