import { appendFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { makeOrchestratorAgentId } from "./agents";
import type {
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  ExternalMessageEnvelope,
  OrchestratorChannelConfig,
} from "./contracts";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { type ChatOutput, MultiAgentRuntime } from "./runtime";
import type { HITLHandler } from "./tool-middleware";

const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai";
const DEFAULT_BASE_DATA_DIR = join(".runtime-data", "orgs");
const ORG_SESSION_ID = "default";
const CHANNELS_FILE = "orchestrator-channels.json";
const CHANNEL_EVENTS_FILE = "channel-events.jsonl";
const COMMUNICATION_INTENTS_FILE = "communication-intents.jsonl";

interface RuntimeManagerOptions {
  baseDataDir?: string;
  kapsoApiBaseUrl?: string;
  kapsoApiKey?: string;
  kapsoFallbackTemplateName?: string;
  kapsoFallbackTemplateLanguageCode?: string;
  hitlHandler?: HITLHandler;
  onChannelEvent?: (event: ChannelDeliveryEvent) => void | Promise<void>;
  onCommunicationIntent?: (intent: CommunicationIntentLog) => void | Promise<void>;
}

export interface OrgRuntime {
  orgId: string;
  runtime: MultiAgentRuntime;
}

interface InternalOrgRuntime extends OrgRuntime {
  dataDir: string;
  channels: OrchestratorChannelConfig[];
}

interface SetupLinkResult {
  setupLinkUrl: string;
  channelConfig: OrchestratorChannelConfig;
}

interface KapsoCreateCustomerResult {
  customerId: string;
}

interface KapsoCreateSetupLinkResult {
  url: string;
}

class KapsoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Kapso request failed (${response.status} ${response.statusText}): ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new Error(`Kapso request returned non-JSON response for ${path}`);
    }
  }

  async createCustomer(input: { name: string; externalCustomerId: string }): Promise<KapsoCreateCustomerResult> {
    const payload = {
      customer: {
        name: input.name,
        external_customer_id: input.externalCustomerId,
      },
    };
    const result = await this.request<{ data?: { id?: string } }>("/platform/v1/customers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const customerId = result.data?.id;
    if (!customerId) throw new Error("Kapso did not return customer id.");
    return { customerId };
  }

  async createSetupLink(customerId: string): Promise<KapsoCreateSetupLinkResult> {
    const payload = {
      setup_link: {
        allowed_connection_types: ["dedicated"],
        provision_phone_number: true,
      },
    };
    const result = await this.request<{ data?: { url?: string } }>(
      `/platform/v1/customers/${customerId}/setup_links`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    const url = result.data?.url;
    if (!url) throw new Error("Kapso did not return setup link URL.");
    return { url };
  }

  async sendTextMessage(input: { phoneNumberId: string; to: string; body: string }): Promise<{ messageId?: string }> {
    const payload = {
      messaging_product: "whatsapp",
      to: input.to,
      type: "text",
      text: { body: input.body },
    };
    const result = await this.request<{ messages?: Array<{ id?: string }> }>(
      `/meta/whatsapp/v24.0/${input.phoneNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    return { messageId: result.messages?.[0]?.id };
  }

  async sendTemplateMessage(input: {
    phoneNumberId: string;
    to: string;
    templateName: string;
    languageCode: string;
  }): Promise<{ messageId?: string }> {
    const payload = {
      messaging_product: "whatsapp",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
      },
    };
    const result = await this.request<{ messages?: Array<{ id?: string }> }>(
      `/meta/whatsapp/v24.0/${input.phoneNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    return { messageId: result.messages?.[0]?.id };
  }
}

function normalizePhoneNumber(phone: string): string {
  return phone.replace(/[^\d+]/g, "").trim();
}

function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => tryParseJson<T>(line))
    .filter((item): item is T => item !== undefined);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return fallback;
    const parsed = tryParseJson<T>(await file.text());
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(value, null, 2));
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

export class RuntimeManager {
  private readonly baseDataDir: string;
  private readonly kapsoApiBaseUrl: string;
  private readonly kapsoApiKey?: string;
  private readonly kapsoFallbackTemplateName?: string;
  private readonly kapsoFallbackTemplateLanguageCode: string;
  private readonly hitlHandler?: HITLHandler;
  private readonly runtimes = new Map<string, InternalOrgRuntime>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly onChannelEvent?: (event: ChannelDeliveryEvent) => void | Promise<void>;
  private readonly onCommunicationIntent?: (intent: CommunicationIntentLog) => void | Promise<void>;

  constructor(opts?: RuntimeManagerOptions) {
    this.baseDataDir = opts?.baseDataDir ?? DEFAULT_BASE_DATA_DIR;
    this.kapsoApiBaseUrl = opts?.kapsoApiBaseUrl ?? process.env.KAPSO_API_BASE_URL ?? DEFAULT_KAPSO_BASE_URL;
    this.kapsoApiKey = opts?.kapsoApiKey ?? process.env.KAPSO_API_KEY;
    this.kapsoFallbackTemplateName = opts?.kapsoFallbackTemplateName ?? process.env.KAPSO_FALLBACK_TEMPLATE_NAME;
    this.kapsoFallbackTemplateLanguageCode = opts?.kapsoFallbackTemplateLanguageCode
      ?? process.env.KAPSO_FALLBACK_TEMPLATE_LANGUAGE_CODE
      ?? "en_US";
    this.hitlHandler = opts?.hitlHandler;
    this.onChannelEvent = opts?.onChannelEvent;
    this.onCommunicationIntent = opts?.onCommunicationIntent;
  }

  private shouldTryTemplateFallback(err: unknown): boolean {
    if (!this.kapsoFallbackTemplateName) return false;
    const message = errorMessage(err).toLowerCase();
    return (
      (message.includes("24") && (message.includes("hour") || message.includes("window"))) ||
      message.includes("outside session") ||
      message.includes("outside allowed window")
    );
  }

  private orgDataDir(orgId: string): string {
    return join(this.baseDataDir, orgId);
  }

  private channelsFile(orgId: string): string {
    return join(this.orgDataDir(orgId), CHANNELS_FILE);
  }

  private channelEventsFile(orgId: string): string {
    return join(this.orgDataDir(orgId), CHANNEL_EVENTS_FILE);
  }

  private communicationIntentsFile(orgId: string): string {
    return join(this.orgDataDir(orgId), COMMUNICATION_INTENTS_FILE);
  }

  private async loadChannels(orgId: string): Promise<OrchestratorChannelConfig[]> {
    const raw = await readJsonFile<OrchestratorChannelConfig[] | OrchestratorChannelConfig>(this.channelsFile(orgId), []);
    const rows = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === "object" ? [raw] : []);
    return rows
      .filter((row) => row && typeof row.orchestratorId === "string")
      .map((row) => ({
        ...row,
        ownerNumber: normalizePhoneNumber(row.ownerNumber),
      }))
      .sort((a, b) => a.orchestratorId.localeCompare(b.orchestratorId));
  }

  private async saveChannels(orgId: string, channels: OrchestratorChannelConfig[]): Promise<void> {
    await writeJsonFile(this.channelsFile(orgId), channels);
  }

  private async ensureOrgRuntime(orgId: string): Promise<InternalOrgRuntime> {
    const existing = this.runtimes.get(orgId);
    const channels = await this.loadChannels(orgId);
    const orchestratorIds = channels.map((channel) => makeOrchestratorAgentId(channel.orchestratorId));
    const runtimeNeedsReload = existing
      ? JSON.stringify(existing.channels.map((channel) => channel.orchestratorId).sort())
        !== JSON.stringify(channels.map((channel) => channel.orchestratorId).sort())
      : true;

    if (existing && !runtimeNeedsReload) {
      existing.channels = channels;
      return existing;
    }

    const runtime = new MultiAgentRuntime({
      sessionId: ORG_SESSION_ID,
      orgId,
      dataDir: this.orgDataDir(orgId),
      orchestratorIds: orchestratorIds.length > 0 ? orchestratorIds : [makeOrchestratorAgentId()],
      hitlHandler: this.hitlHandler,
      deliverResult: async (job, result) => {
        if (!job.contact || !job.orchestratorId) return;
        await this.sendChannelMessage(orgId, job.orchestratorId, job.contact, result);
      },
      sendMessage: async (msgOrgId, orchestratorId, contact, body) => {
        await this.sendChannelMessage(msgOrgId, orchestratorId, contact, body);
      },
    });

    const next: InternalOrgRuntime = {
      orgId,
      dataDir: this.orgDataDir(orgId),
      runtime,
      channels,
    };
    this.runtimes.set(orgId, next);
    return next;
  }

  async getOrgRuntime(orgId: string): Promise<OrgRuntime> {
    return this.ensureOrgRuntime(orgId);
  }

  async listOrchestrators(orgId: string): Promise<OrchestratorChannelConfig[]> {
    const state = await this.ensureOrgRuntime(orgId);
    return [...state.channels];
  }

  async listChannelEvents(orgId: string): Promise<ChannelDeliveryEvent[]> {
    const file = Bun.file(this.channelEventsFile(orgId));
    if (!(await file.exists())) return [];
    return parseJsonLines<ChannelDeliveryEvent>(await file.text()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async listCommunicationIntents(orgId: string): Promise<CommunicationIntentLog[]> {
    const file = Bun.file(this.communicationIntentsFile(orgId));
    if (!(await file.exists())) return [];
    return parseJsonLines<CommunicationIntentLog>(await file.text()).sort((a, b) => b.timestamp - a.timestamp);
  }

  private async emitChannelEvent(event: ChannelDeliveryEvent): Promise<void> {
    await appendJsonLine(this.channelEventsFile(event.orgId), event);
    try {
      await this.onChannelEvent?.(event);
    } catch (err) {
      console.error("[runtime-manager] onChannelEvent failed:", errorMessage(err));
    }
  }

  private async emitCommunicationIntent(intent: CommunicationIntentLog): Promise<void> {
    await appendJsonLine(this.communicationIntentsFile(intent.orgId), intent);
    try {
      await this.onCommunicationIntent?.(intent);
    } catch (err) {
      console.error("[runtime-manager] onCommunicationIntent failed:", errorMessage(err));
    }
  }

  async recordChannelEvent(event: ChannelDeliveryEvent): Promise<void> {
    await this.emitChannelEvent(event);
  }

  async recordCommunicationIntent(intent: CommunicationIntentLog): Promise<void> {
    await this.emitCommunicationIntent(intent);
  }

  /**
   * Send a message to a contact via their WhatsApp channel.
   * Used by the HITL handler to dispatch approval requests over WhatsApp.
   */
  async sendChannelMessage(orgId: string, orchestratorId: string, contact: string, body: string): Promise<void> {
    const state = await this.ensureOrgRuntime(orgId);
    const channel = state.channels.find((r) => r.orchestratorId === orchestratorId);
    if (!channel?.phoneNumberId) {
      throw new Error(`No phoneNumberId configured for orchestrator '${orchestratorId}' in org '${orgId}'.`);
    }
    const kapso = this.requireKapsoClient();
    await kapso.sendTextMessage({ phoneNumberId: channel.phoneNumberId, to: contact, body });
  }

  private enqueueConversation<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    const tracked = next.then(() => undefined).catch(() => undefined);
    this.conversationLocks.set(key, tracked);
    return next.finally(() => {
      if (this.conversationLocks.get(key) === tracked) {
        this.conversationLocks.delete(key);
      }
    });
  }

  private requireKapsoClient(): KapsoClient {
    if (!this.kapsoApiKey) {
      throw new Error("Kapso integration is disabled: missing KAPSO_API_KEY.");
    }
    return new KapsoClient(this.kapsoApiBaseUrl, this.kapsoApiKey);
  }

  async createOrchestratorWithSetupLink(input: {
    orgId: string;
    orchestratorId: string;
    ownerNumber: string;
  }): Promise<SetupLinkResult> {
    const orgId = input.orgId.trim();
    const orchestratorId = makeOrchestratorAgentId(input.orchestratorId);
    const ownerNumber = normalizePhoneNumber(input.ownerNumber);
    if (!orgId || !orchestratorId || !ownerNumber) {
      throw new Error("orgId, orchestratorId, and ownerNumber are required.");
    }

    const kapso = this.requireKapsoClient();
    const externalCustomerId = `${orgId}:${orchestratorId}`;
    const customer = await kapso.createCustomer({
      name: `Orchestrator ${orchestratorId} (${orgId})`,
      externalCustomerId,
    });
    const setupLink = await kapso.createSetupLink(customer.customerId);

    const state = await this.ensureOrgRuntime(orgId);
    const nowTs = now();
    const config: OrchestratorChannelConfig = {
      orgId,
      orchestratorId,
      kapsoCustomerId: customer.customerId,
      phoneNumberId: undefined,
      ownerNumber,
      active: true,
      createdAt: nowTs,
      updatedAt: nowTs,
    };

    const nextChannels = state.channels.filter((row) => row.orchestratorId !== orchestratorId);
    nextChannels.push(config);
    await this.saveChannels(orgId, nextChannels);
    await this.ensureOrgRuntime(orgId);

    return { setupLinkUrl: setupLink.url, channelConfig: config };
  }

  async upsertOrchestratorChannel(input: {
    orgId: string;
    orchestratorId: string;
    ownerNumber: string;
    kapsoCustomerId: string;
    phoneNumberId?: string;
    active?: boolean;
  }): Promise<OrchestratorChannelConfig> {
    const orgId = input.orgId.trim();
    const orchestratorId = makeOrchestratorAgentId(input.orchestratorId);
    const ownerNumber = normalizePhoneNumber(input.ownerNumber);
    const kapsoCustomerId = input.kapsoCustomerId.trim();
    const nextPhoneNumberId = input.phoneNumberId?.trim();
    const active = input.active ?? true;
    if (!orgId || !orchestratorId || !ownerNumber || !kapsoCustomerId) {
      throw new Error("orgId, orchestratorId, ownerNumber, and kapsoCustomerId are required.");
    }

    const state = await this.ensureOrgRuntime(orgId);
    const existing = state.channels.find((row) => row.orchestratorId === orchestratorId);
    const nowTs = now();
    const config: OrchestratorChannelConfig = {
      orgId,
      orchestratorId,
      kapsoCustomerId,
      phoneNumberId: nextPhoneNumberId ?? existing?.phoneNumberId,
      ownerNumber,
      active,
      createdAt: existing?.createdAt ?? nowTs,
      updatedAt: nowTs,
    };

    const nextChannels = state.channels.filter((row) => row.orchestratorId !== orchestratorId);
    nextChannels.push(config);
    await this.saveChannels(orgId, nextChannels);
    await this.ensureOrgRuntime(orgId);
    return config;
  }

  async bindPhoneNumberByCustomer(customerId: string, phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const normalizedCustomerId = customerId.trim();
    const normalizedPhoneNumberId = phoneNumberId.trim();
    if (!normalizedCustomerId || !normalizedPhoneNumberId) return undefined;

    const orgDirs = await this.listOrgDirectories();
    for (const orgId of orgDirs) {
      const channels = await this.loadChannels(orgId);
      const index = channels.findIndex((channel) => channel.kapsoCustomerId === normalizedCustomerId);
      if (index < 0) continue;
      const updated: OrchestratorChannelConfig = {
        ...channels[index]!,
        phoneNumberId: normalizedPhoneNumberId,
        updatedAt: now(),
      };
      channels[index] = updated;
      await this.saveChannels(orgId, channels);
      await this.ensureOrgRuntime(orgId);
      return updated;
    }
    return undefined;
  }

  async findChannelByPhoneNumberId(phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const normalized = phoneNumberId.trim();
    if (!normalized) return undefined;

    const orgDirs = await this.listOrgDirectories();
    for (const orgId of orgDirs) {
      const channels = await this.loadChannels(orgId);
      const found = channels.find((channel) => channel.phoneNumberId === normalized);
      if (found) return found;
    }
    return undefined;
  }

  async chatFromUi(input: {
    orgId: string;
    orchestratorId: string;
    content: string;
    contact?: string;
    onAgentEvent?: (event: AgentEvent) => void;
  }): Promise<ChatOutput> {
    const org = await this.ensureOrgRuntime(input.orgId);
    const toAgentId = makeOrchestratorAgentId(input.orchestratorId);
    const normalizedContact = input.contact ? normalizePhoneNumber(input.contact) : undefined;
    const fromAgentId = normalizedContact ? `external:${normalizedContact}` : "user";
    return org.runtime.chat({
      toAgentId,
      fromAgentId,
      content: input.content,
      initiator: normalizedContact ? "external" : "user",
      channel: normalizedContact ? "whatsapp" : "ui",
      contact: normalizedContact,
      orchestratorId: toAgentId,
      metadata: { source: "ui" },
      onAgentEvent: input.onAgentEvent,
    });
  }

  async processExternalMessage(input: ExternalMessageEnvelope): Promise<{
    blocked: boolean;
    reason?: string;
    answer?: string;
    threadId?: string;
    runId?: string;
    orchestratorAgentId: string;
  }> {
    const orchestratorAgentId = makeOrchestratorAgentId(input.orchestratorId);
    const normalizedContact = normalizePhoneNumber(input.contact);
    const conversationKey = `${input.orgId}:${input.orchestratorId}:${normalizedContact}`;
    return this.enqueueConversation(conversationKey, async () => {
      const org = await this.ensureOrgRuntime(input.orgId);
      const channel = org.channels.find((row) => row.orchestratorId === input.orchestratorId);
      if (!channel) {
        return { blocked: true, reason: "orchestrator_not_configured", orchestratorAgentId };
      }
      if (!channel.active) {
        return { blocked: true, reason: "orchestrator_inactive", orchestratorAgentId };
      }

      const normalizedOwner = normalizePhoneNumber(channel.ownerNumber);
      if (normalizedContact !== normalizedOwner) {
        const intent: CommunicationIntentLog = {
          intentId: createId("intent"),
          orgId: input.orgId,
          orchestratorId: input.orchestratorId,
          fromNumber: normalizedContact,
          expectedOwnerNumber: normalizedOwner,
          reason: "owner_number_mismatch",
          timestamp: now(),
          metadata: input.metadata,
        };
        await this.emitCommunicationIntent(intent);
        return { blocked: true, reason: "owner_number_mismatch", orchestratorAgentId };
      }

      const inboundEvent: ChannelDeliveryEvent = {
        eventId: createId("ch_evt"),
        orgId: input.orgId,
        orchestratorId: input.orchestratorId,
        channel: input.channel,
        contact: normalizedContact,
        direction: "inbound",
        status: "received",
        timestamp: input.timestamp || now(),
        messageId: input.messageId,
        metadata: {
          ...(input.metadata ?? {}),
          text: input.content,
        },
      };
      await this.emitChannelEvent(inboundEvent);

      const output = await org.runtime.chat({
        toAgentId: orchestratorAgentId,
        fromAgentId: `external:${normalizedContact}`,
        content: input.content,
        initiator: "external",
        channel: input.channel,
        contact: normalizedContact,
        orchestratorId: orchestratorAgentId,
        metadata: input.metadata,
      });

      const answer = output.answer.trim();
      if (!answer) {
        return {
          blocked: false,
          answer,
          threadId: output.threadId,
          runId: output.runContext.runId,
          orchestratorAgentId,
        };
      }

      const sentEvent: ChannelDeliveryEvent = {
        eventId: createId("ch_evt"),
        orgId: input.orgId,
        orchestratorId: input.orchestratorId,
        channel: input.channel,
        contact: normalizedContact,
        direction: "outbound",
        status: "sent",
        timestamp: now(),
        metadata: {
          source: "runtime",
          text: answer,
          threadId: output.threadId,
          runId: output.runContext.runId,
        },
      };
      await this.emitChannelEvent(sentEvent);

      if (input.channel === "whatsapp") {
        const kapso = this.requireKapsoClient();
        if (!channel.phoneNumberId) {
          const failedEvent: ChannelDeliveryEvent = {
            ...sentEvent,
            eventId: createId("ch_evt"),
            status: "failed",
            error: "missing_phone_number_id",
            timestamp: now(),
          };
          await this.emitChannelEvent(failedEvent);
          return {
            blocked: false,
            answer,
            threadId: output.threadId,
            runId: output.runContext.runId,
            orchestratorAgentId,
          };
        }
        try {
          const sendResult = await kapso.sendTextMessage({
            phoneNumberId: channel.phoneNumberId,
            to: normalizedContact,
            body: answer,
          });
          const deliveredEvent: ChannelDeliveryEvent = {
            ...sentEvent,
            eventId: createId("ch_evt"),
            status: "delivered",
            timestamp: now(),
            messageId: sendResult.messageId,
            metadata: {
              ...sentEvent.metadata,
              phoneNumberId: channel.phoneNumberId,
            },
          };
          await this.emitChannelEvent(deliveredEvent);
        } catch (err) {
          if (this.shouldTryTemplateFallback(err) && this.kapsoFallbackTemplateName) {
            try {
              const fallbackResult = await kapso.sendTemplateMessage({
                phoneNumberId: channel.phoneNumberId,
                to: normalizedContact,
                templateName: this.kapsoFallbackTemplateName,
                languageCode: this.kapsoFallbackTemplateLanguageCode,
              });
              const fallbackDeliveredEvent: ChannelDeliveryEvent = {
                ...sentEvent,
                eventId: createId("ch_evt"),
                status: "delivered",
                timestamp: now(),
                messageId: fallbackResult.messageId,
                metadata: {
                  ...sentEvent.metadata,
                  phoneNumberId: channel.phoneNumberId,
                  deliveryMode: "template_fallback",
                  templateName: this.kapsoFallbackTemplateName,
                  templateLanguageCode: this.kapsoFallbackTemplateLanguageCode,
                },
              };
              await this.emitChannelEvent(fallbackDeliveredEvent);
            } catch (fallbackErr) {
              const failedEvent: ChannelDeliveryEvent = {
                ...sentEvent,
                eventId: createId("ch_evt"),
                status: "failed",
                timestamp: now(),
                error: `${errorMessage(err)} | template_fallback_failed: ${errorMessage(fallbackErr)}`,
              };
              await this.emitChannelEvent(failedEvent);
            }
            return {
              blocked: false,
              answer,
              threadId: output.threadId,
              runId: output.runContext.runId,
              orchestratorAgentId,
            };
          }

          const failedEvent: ChannelDeliveryEvent = {
            ...sentEvent,
            eventId: createId("ch_evt"),
            status: "failed",
            timestamp: now(),
            error: errorMessage(err),
          };
          await this.emitChannelEvent(failedEvent);
        }
      }

      return {
        blocked: false,
        answer,
        threadId: output.threadId,
        runId: output.runContext.runId,
        orchestratorAgentId,
      };
    });
  }

  async listConversations(orgId: string, orchestratorId?: string): Promise<Array<{
    orgId: string;
    orchestratorId: string;
    contact: string;
    lastDirection: "inbound" | "outbound";
    lastStatus: ChannelDeliveryEvent["status"];
    lastTimestamp: number;
    preview?: string;
  }>> {
    const events = await this.listChannelEvents(orgId);
    const grouped = new Map<string, {
      orgId: string;
      orchestratorId: string;
      contact: string;
      lastDirection: "inbound" | "outbound";
      lastStatus: ChannelDeliveryEvent["status"];
      lastTimestamp: number;
      preview?: string;
    }>();

    for (const event of events) {
      if (orchestratorId && event.orchestratorId !== orchestratorId) continue;
      const key = `${event.orchestratorId}:${event.contact}`;
      const existing = grouped.get(key);
      if (existing && existing.lastTimestamp > event.timestamp) continue;
      grouped.set(key, {
        orgId: event.orgId,
        orchestratorId: event.orchestratorId,
        contact: event.contact,
        lastDirection: event.direction,
        lastStatus: event.status,
        lastTimestamp: event.timestamp,
        preview: typeof event.metadata?.text === "string" ? String(event.metadata.text) : undefined,
      });
    }
    return [...grouped.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  private async listOrgDirectories(): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDataDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }
}
