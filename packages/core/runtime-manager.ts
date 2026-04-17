import { join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgentDefinitions, isOrchestratorAgentId, makeOrchestratorAgentId } from "./agents";
import type { AgentDefinition } from "./agent-builder";
import type {
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  ExternalMessageEnvelope,
  OrchestratorChannelConfig,
} from "./contracts";
import type { CredentialStorePort } from "./credential-store";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { normalizePhoneNumber } from "./phone-utils";
import { SecretCrypto } from "./secret-crypto";
import { SupabaseCredentialStore } from "./supabase-credential-store";
import { createSupabaseAdminClient, readSupabaseAdminConfigFromEnv } from "./supabase-client";
import { SupabaseRuntimeStore } from "./supabase-runtime-store";
import { type ChatOutput, MultiAgentRuntime } from "./runtime";
import type { HITLHandler } from "./tool-middleware";

const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai";
const DEFAULT_BASE_DATA_DIR = join(".runtime-data", "orgs");
const ORG_SESSION_ID = "default";
const DEFAULT_SECRET_KEY_VERSION = 1;
const RUNTIME_ENV_OVERRIDE_KEYS = [
  "OPENROUTER_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "MASTER_PASSWORD",
  "KAPSO_API_KEY",
  "KAPSO_API_BASE_URL",
  "KAPSO_WEBHOOK_SECRET",
  "KAPSO_PROJECT_WEBHOOK_SECRET",
  "KAPSO_PHONE_WEBHOOK_SECRET",
  "KAPSO_FALLBACK_TEMPLATE_NAME",
  "KAPSO_FALLBACK_TEMPLATE_LANGUAGE_CODE",
  "BROWSE_LLM_MODEL",
  "BROWSE_INTERACT_MAX_RETRIES",
  "MAX_HISTORY_MESSAGES",
  "COMPACTION_THRESHOLD",
  "COMPACTION_KEEP",
] as const;
const PROCESS_ENV_RUNTIME_KEYS = [
  "OPENROUTER_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "MASTER_PASSWORD",
] as const;

interface RuntimeManagerOptions {
  baseDataDir?: string;
  kapsoApiBaseUrl?: string;
  kapsoApiKey?: string;
  kapsoFallbackTemplateName?: string;
  kapsoFallbackTemplateLanguageCode?: string;
  hitlHandler?: HITLHandler;
  runtimeStore?: SupabaseRuntimeStore;
  credentialStoreFactory?: (orgId: string) => CredentialStorePort;
  secretCrypto?: SecretCrypto;
  secretKeyVersion?: number;
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
  configVersion: number;
  configSignature: string;
  channelSignature: string;
}

interface OrgAgentConfigEntry {
  enabled?: boolean;
  maxConcurrency?: number;
}

interface OrgConfigShape {
  agents?: Record<string, OrgAgentConfigEntry>;
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function parseOrgConfig(config: Record<string, unknown> | undefined): OrgConfigShape {
  if (!config || typeof config !== "object") return {};
  const agentsRaw = (config as Record<string, unknown>).agents;
  if (!agentsRaw || typeof agentsRaw !== "object" || Array.isArray(agentsRaw)) {
    return {};
  }
  const agents: Record<string, OrgAgentConfigEntry> = {};
  for (const [agentId, rawEntry] of Object.entries(agentsRaw as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    agents[agentId] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      maxConcurrency: typeof entry.maxConcurrency === "number" ? entry.maxConcurrency : undefined,
    };
  }
  return { agents };
}

function applyOrgAgentConfig(baseDefs: AgentDefinition[], config: OrgConfigShape): {
  defs: AgentDefinition[];
  signature: string;
  orchestratorIds: string[];
} {
  const agentConfig = config.agents ?? {};
  const enabledEntries = Object.entries(agentConfig).filter(([, value]) => value.enabled === true);
  if (enabledEntries.length === 0) {
    const fallbackOrchestrators = baseDefs.filter((def) => isOrchestratorAgentId(def.id)).map((def) => def.id);
    return {
      defs: baseDefs,
      signature: "default",
      orchestratorIds: fallbackOrchestrators,
    };
  }

  const enabledSet = new Set(enabledEntries.map(([agentId]) => agentId));
  const maxConcurrencyById = new Map<string, number>();
  for (const [agentId, entry] of enabledEntries) {
    if (typeof entry.maxConcurrency === "number" && Number.isFinite(entry.maxConcurrency) && entry.maxConcurrency > 0) {
      maxConcurrencyById.set(agentId, Math.floor(entry.maxConcurrency));
    }
  }

  const selected = baseDefs
    .filter((def) => enabledSet.has(def.id))
    .map((def) => {
      const override = maxConcurrencyById.get(def.id);
      if (!override || override === def.maxConcurrency) return def;
      return { ...def, maxConcurrency: override };
    });

  if (selected.length === 0) {
    const fallbackOrchestrators = baseDefs.filter((def) => isOrchestratorAgentId(def.id)).map((def) => def.id);
    return {
      defs: baseDefs,
      signature: "default",
      orchestratorIds: fallbackOrchestrators,
    };
  }

  const orchestratorIds = selected.filter((def) => isOrchestratorAgentId(def.id)).map((def) => def.id);
  if (orchestratorIds.length === 0) {
    const defaultOrchestrator = baseDefs.find((def) => isOrchestratorAgentId(def.id));
    if (defaultOrchestrator) {
      selected.unshift(defaultOrchestrator);
      orchestratorIds.push(defaultOrchestrator.id);
    }
  }

  return {
    defs: selected,
    signature: stableStringify(agentConfig),
    orchestratorIds,
  };
}

export class RuntimeManager {
  private readonly baseDataDir: string;
  private readonly kapsoApiBaseUrl: string;
  private readonly kapsoApiKey?: string;
  private readonly kapsoFallbackTemplateName?: string;
  private readonly kapsoFallbackTemplateLanguageCode: string;
  private readonly hitlHandler?: HITLHandler;
  private readonly runtimeStore: SupabaseRuntimeStore;
  private readonly credentialStoreFactory: (orgId: string) => CredentialStorePort;
  private readonly runtimeEnvOverrideKeys = new Set<string>(RUNTIME_ENV_OVERRIDE_KEYS);
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

    const supabaseConfig = readSupabaseAdminConfigFromEnv();
    const supabaseClient = supabaseConfig
      ? createSupabaseAdminClient(supabaseConfig)
      : undefined;
    const secretCrypto = opts?.secretCrypto ?? (() => {
      const masterKey = process.env.MASTER_ENCRYPTION_KEY?.trim();
      if (!masterKey) return undefined;
      return new SecretCrypto(masterKey);
    })();

    this.runtimeStore = opts?.runtimeStore ?? (() => {
      if (!supabaseClient) {
        throw new Error("Supabase runtime store requires SUPABASE_URL and SUPABASE_SECRET_KEY (fallback: SUPABASE_SERVICE_ROLE_KEY).");
      }
      return new SupabaseRuntimeStore({ client: supabaseClient, crypto: secretCrypto });
    })();

    this.credentialStoreFactory = opts?.credentialStoreFactory ?? (() => {
      if (!supabaseClient) {
        throw new Error("Supabase credential store requires SUPABASE_URL and SUPABASE_SECRET_KEY (fallback: SUPABASE_SERVICE_ROLE_KEY).");
      }
      if (!secretCrypto) {
        throw new Error("Supabase credential store requires MASTER_ENCRYPTION_KEY.");
      }
      const keyVersion = opts?.secretKeyVersion ?? DEFAULT_SECRET_KEY_VERSION;
      return (orgId: string) => new SupabaseCredentialStore({
        client: supabaseClient,
        crypto: secretCrypto,
        orgId,
        keyVersion,
      });
    })();
  }

  private computeChannelSignature(channels: OrchestratorChannelConfig[]): string {
    const canonical = channels
      .map((channel) => ({
        userId: channel.userId,
        orchestratorId: channel.orchestratorId,
        phoneNumberId: channel.phoneNumberId ?? null,
        ownerNumber: channel.ownerNumber,
        active: channel.active,
        kapsoCustomerId: channel.kapsoCustomerId,
      }))
      .sort((a, b) => a.orchestratorId.localeCompare(b.orchestratorId));
    return stableStringify(canonical);
  }

  private parseOrchestratorIdsFromOrgConfig(config: OrgConfigShape): string[] {
    const configured = Object.entries(config.agents ?? {})
      .filter(([agentId]) => isOrchestratorAgentId(agentId))
      .map(([agentId]) => makeOrchestratorAgentId(agentId));
    return [...new Set(configured)].sort((a, b) => a.localeCompare(b));
  }

  private async resolveRuntimeOverride(
    key: string,
    context?: { orgId?: string; userId?: string; orchestratorId?: string },
  ): Promise<string | undefined> {
    if (!this.runtimeEnvOverrideKeys.has(key)) {
      return process.env[key];
    }
    const overridden = await this.runtimeStore.resolveEnvOverride(key, context);
    if (typeof overridden === "string" && overridden.length > 0) return overridden;
    return process.env[key];
  }

  async resolveEnvOverride(
    key: string,
    context?: { orgId?: string; userId?: string; orchestratorId?: string },
  ): Promise<string | undefined> {
    return this.resolveRuntimeOverride(key, context);
  }

  private async shouldTryTemplateFallback(
    err: unknown,
    context?: { orgId?: string; userId?: string; orchestratorId?: string },
  ): Promise<boolean> {
    const fallbackTemplate = await this.resolveRuntimeOverride("KAPSO_FALLBACK_TEMPLATE_NAME", context)
      ?? this.kapsoFallbackTemplateName;
    if (!fallbackTemplate) return false;
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

  private async loadChannels(orgId: string): Promise<OrchestratorChannelConfig[]> {
    const rows = await this.runtimeStore.listOrchestratorChannels(orgId);
    return rows
      .map((row) => ({ ...row, ownerNumber: normalizePhoneNumber(row.ownerNumber) }))
      .sort((a, b) => a.orchestratorId.localeCompare(b.orchestratorId));
  }

  private async ensureOrgRuntime(orgId: string): Promise<InternalOrgRuntime> {
    await this.syncProcessEnvFromOverrides({ orgId });
    const existing = this.runtimes.get(orgId);
    const orgConfigRecord = await this.runtimeStore.getOrgConfig(orgId);
    if (!orgConfigRecord) {
      throw new Error(`Organization '${orgId}' not found in Supabase orgs table.`);
    }
    const parsedConfig = parseOrgConfig(orgConfigRecord.config);
    const channels = await this.loadChannels(orgId);
    const channelSignature = this.computeChannelSignature(channels);
    const configuredOrchestratorIds = this.parseOrchestratorIdsFromOrgConfig(parsedConfig);
    const credentialStore = this.credentialStoreFactory(orgId);
    const baseDefs = createAgentDefinitions({
      credentialStore,
      orchestratorIds: configuredOrchestratorIds.length > 0 ? configuredOrchestratorIds : undefined,
    });
    const applied = applyOrgAgentConfig(baseDefs, parsedConfig);
    const orchestratorIds = applied.orchestratorIds.length > 0
      ? applied.orchestratorIds
      : [makeOrchestratorAgentId()];
    const runtimeNeedsReload = existing
      ? existing.configVersion !== orgConfigRecord.configVersion
        || existing.configSignature !== applied.signature
        || existing.channelSignature !== channelSignature
      : true;

    if (existing && !runtimeNeedsReload) {
      existing.channels = channels;
      existing.configVersion = orgConfigRecord.configVersion;
      existing.configSignature = applied.signature;
      existing.channelSignature = channelSignature;
      return existing;
    }

    const runtime = new MultiAgentRuntime({
      sessionId: ORG_SESSION_ID,
      orgId,
      dataDir: this.orgDataDir(orgId),
      agents: applied.defs,
      orchestratorIds,
      credentialStore,
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
      configVersion: orgConfigRecord.configVersion,
      configSignature: applied.signature,
      channelSignature,
    };
    this.runtimes.set(orgId, next);
    return next;
  }

  async getOrgRuntime(orgId: string): Promise<OrgRuntime> {
    return this.ensureOrgRuntime(orgId);
  }

  private async syncProcessEnvFromOverrides(
    context?: { orgId?: string; userId?: string; orchestratorId?: string },
  ): Promise<void> {
    for (const key of PROCESS_ENV_RUNTIME_KEYS) {
      const value = await this.resolveRuntimeOverride(key, context);
      if (typeof value === "string" && value.length > 0) {
        process.env[key] = value;
      }
    }
  }

  async listUserOrgIds(userId: string): Promise<string[]> {
    const normalized = userId.trim();
    if (!normalized) return [];
    return this.runtimeStore.listMembershipOrgIds(normalized);
  }

  async isUserMemberOfOrg(userId: string, orgId: string): Promise<boolean> {
    const normalizedUserId = userId.trim();
    const normalizedOrgId = orgId.trim();
    if (!normalizedUserId || !normalizedOrgId) return false;
    return this.runtimeStore.isMemberOfOrg(normalizedUserId, normalizedOrgId);
  }

  async listOrchestrators(orgId: string): Promise<OrchestratorChannelConfig[]> {
    const state = await this.ensureOrgRuntime(orgId);
    return [...state.channels];
  }

  async listChannelEvents(orgId: string): Promise<ChannelDeliveryEvent[]> {
    return this.runtimeStore.listChannelEvents(orgId);
  }

  async listCommunicationIntents(orgId: string): Promise<CommunicationIntentLog[]> {
    return this.runtimeStore.listCommunicationIntents(orgId);
  }

  private async emitChannelEvent(event: ChannelDeliveryEvent): Promise<void> {
    await this.runtimeStore.appendChannelEvent(event);
    try {
      await this.onChannelEvent?.(event);
    } catch (err) {
      console.error("[runtime-manager] onChannelEvent failed:", errorMessage(err));
    }
  }

  private async emitCommunicationIntent(intent: CommunicationIntentLog): Promise<void> {
    await this.runtimeStore.appendCommunicationIntent(intent);
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
    const kapso = await this.requireKapsoClient({ orgId, userId: channel.userId, orchestratorId });
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

  private async requireKapsoClient(
    context?: { orgId?: string; userId?: string; orchestratorId?: string },
  ): Promise<KapsoClient> {
    const resolvedApiKey = await this.resolveRuntimeOverride("KAPSO_API_KEY", context) ?? this.kapsoApiKey;
    const resolvedBaseUrl = await this.resolveRuntimeOverride("KAPSO_API_BASE_URL", context) ?? this.kapsoApiBaseUrl;
    if (!resolvedApiKey) {
      throw new Error("Kapso integration is disabled: missing KAPSO_API_KEY.");
    }
    return new KapsoClient(resolvedBaseUrl, resolvedApiKey);
  }

  async createOrchestratorWithSetupLink(input: {
    orgId: string;
    userId: string;
    orchestratorId: string;
    ownerNumber: string;
  }): Promise<SetupLinkResult> {
    const orgId = input.orgId.trim();
    const userId = input.userId.trim();
    const orchestratorId = makeOrchestratorAgentId(input.orchestratorId);
    const ownerNumber = normalizePhoneNumber(input.ownerNumber);
    if (!orgId || !userId || !orchestratorId || !ownerNumber) {
      throw new Error("orgId, userId, orchestratorId, and ownerNumber are required.");
    }
    const isMember = await this.isUserMemberOfOrg(userId, orgId);
    if (!isMember) {
      throw new Error(`User '${userId}' is not a member of org '${orgId}'.`);
    }

    const kapso = await this.requireKapsoClient({ orgId, userId, orchestratorId });
    const externalCustomerId = `${orgId}:${orchestratorId}`;
    const customer = await kapso.createCustomer({
      name: `Orchestrator ${orchestratorId} (${orgId})`,
      externalCustomerId,
    });
    const setupLink = await kapso.createSetupLink(customer.customerId);

    const config = await this.runtimeStore.upsertOrchestratorChannel({
      orgId,
      userId,
      orchestratorId,
      ownerNumber,
      kapsoCustomerId: customer.customerId,
      active: true,
    });
    await this.ensureOrgRuntime(orgId);

    return { setupLinkUrl: setupLink.url, channelConfig: config };
  }

  async upsertOrchestratorChannel(input: {
    orgId: string;
    userId: string;
    orchestratorId: string;
    ownerNumber: string;
    kapsoCustomerId: string;
    phoneNumberId?: string;
    active?: boolean;
  }): Promise<OrchestratorChannelConfig> {
    const orgId = input.orgId.trim();
    const userId = input.userId.trim();
    const orchestratorId = makeOrchestratorAgentId(input.orchestratorId);
    const ownerNumber = normalizePhoneNumber(input.ownerNumber);
    const kapsoCustomerId = input.kapsoCustomerId.trim();
    const nextPhoneNumberId = input.phoneNumberId?.trim();
    const active = input.active ?? true;
    if (!orgId || !userId || !orchestratorId || !ownerNumber || !kapsoCustomerId) {
      throw new Error("orgId, userId, orchestratorId, ownerNumber, and kapsoCustomerId are required.");
    }
    const isMember = await this.isUserMemberOfOrg(userId, orgId);
    if (!isMember) {
      throw new Error(`User '${userId}' is not a member of org '${orgId}'.`);
    }

    const existing = (await this.loadChannels(orgId)).find((row) => row.orchestratorId === orchestratorId);
    const config = await this.runtimeStore.upsertOrchestratorChannel({
      orgId,
      userId,
      orchestratorId,
      ownerNumber,
      kapsoCustomerId,
      phoneNumberId: nextPhoneNumberId ?? existing?.phoneNumberId,
      active,
    });
    await this.ensureOrgRuntime(orgId);
    return config;
  }

  async bindPhoneNumberByCustomer(customerId: string, phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const normalizedCustomerId = customerId.trim();
    const normalizedPhoneNumberId = phoneNumberId.trim();
    if (!normalizedCustomerId || !normalizedPhoneNumberId) return undefined;

    const updated = await this.runtimeStore.bindPhoneNumberByCustomer(normalizedCustomerId, normalizedPhoneNumberId);
    if (!updated) return undefined;
    await this.ensureOrgRuntime(updated.orgId);
    return updated;
  }

  async findChannelByPhoneNumberId(phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const normalized = phoneNumberId.trim();
    if (!normalized) return undefined;
    return this.runtimeStore.findChannelByPhoneNumberId(normalized);
  }

  async findChannelByKapsoCustomerId(customerId: string): Promise<OrchestratorChannelConfig | undefined> {
    const normalized = customerId.trim();
    if (!normalized) return undefined;
    return this.runtimeStore.findChannelByKapsoCustomerId(normalized);
  }

  async chatFromUi(input: {
    orgId: string;
    userId?: string;
    orchestratorId: string;
    content: string;
    contact?: string;
    onAgentEvent?: (event: AgentEvent) => void;
  }): Promise<ChatOutput> {
    const org = await this.ensureOrgRuntime(input.orgId);
    const toAgentId = makeOrchestratorAgentId(input.orchestratorId);
    const normalizedContact = input.contact ? normalizePhoneNumber(input.contact) : undefined;
    const channelForOrchestrator = org.channels.find((ch) => ch.orchestratorId === toAgentId);
    if (input.userId && channelForOrchestrator && channelForOrchestrator.userId !== input.userId) {
      throw new Error(`User '${input.userId}' cannot use orchestrator '${toAgentId}'.`);
    }
    await this.syncProcessEnvFromOverrides({
      orgId: input.orgId,
      userId: input.userId,
      orchestratorId: toAgentId,
    });

    // If no explicit contact, fall back to the orchestrator's configured ownerNumber so that
    // start_background_task is available from the UI too — results are delivered to the owner's WA.
    const channelOwner = !normalizedContact
      ? channelForOrchestrator?.active ? channelForOrchestrator.ownerNumber : undefined
      : undefined;
    const resolvedContact = normalizedContact ?? channelOwner;

    const fromAgentId = normalizedContact ? `external:${normalizedContact}` : "user";
    return org.runtime.chat({
      toAgentId,
      fromAgentId,
      content: input.content,
      initiator: normalizedContact ? "external" : "user",
      userId: input.userId,
      channel: normalizedContact ? "whatsapp" : "ui",
      contact: resolvedContact,
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
    const conversationKey = `${input.orgId}:${orchestratorAgentId}:${normalizedContact}`;
    return this.enqueueConversation(conversationKey, async () => {
      await this.syncProcessEnvFromOverrides({
        orgId: input.orgId,
        orchestratorId: orchestratorAgentId,
      });
      const org = await this.ensureOrgRuntime(input.orgId);
      const channel = org.channels.find((row) => row.orchestratorId === orchestratorAgentId);
      if (!channel) {
        return { blocked: true, reason: "orchestrator_not_configured", orchestratorAgentId };
      }
      await this.syncProcessEnvFromOverrides({
        orgId: input.orgId,
        userId: channel.userId,
        orchestratorId: orchestratorAgentId,
      });
      if (!channel.active) {
        return { blocked: true, reason: "orchestrator_inactive", orchestratorAgentId };
      }

      const normalizedOwner = normalizePhoneNumber(channel.ownerNumber);
      if (normalizedContact !== normalizedOwner) {
        const intent: CommunicationIntentLog = {
          intentId: createId("intent"),
          orgId: input.orgId,
          orchestratorId: orchestratorAgentId,
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
        orchestratorId: orchestratorAgentId,
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
        orchestratorId: orchestratorAgentId,
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
        const kapso = await this.requireKapsoClient({
          orgId: input.orgId,
          userId: channel.userId,
          orchestratorId: orchestratorAgentId,
        });
        const fallbackTemplateName = await this.resolveRuntimeOverride("KAPSO_FALLBACK_TEMPLATE_NAME", {
          orgId: input.orgId,
          userId: channel.userId,
          orchestratorId: orchestratorAgentId,
        }) ?? this.kapsoFallbackTemplateName;
        const fallbackTemplateLanguageCode = await this.resolveRuntimeOverride(
          "KAPSO_FALLBACK_TEMPLATE_LANGUAGE_CODE",
          {
            orgId: input.orgId,
            userId: channel.userId,
            orchestratorId: orchestratorAgentId,
          },
        ) ?? this.kapsoFallbackTemplateLanguageCode;
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
          if (await this.shouldTryTemplateFallback(err, {
            orgId: input.orgId,
            userId: channel.userId,
            orchestratorId: orchestratorAgentId,
          }) && fallbackTemplateName) {
            try {
              const fallbackResult = await kapso.sendTemplateMessage({
                phoneNumberId: channel.phoneNumberId,
                to: normalizedContact,
                templateName: fallbackTemplateName,
                languageCode: fallbackTemplateLanguageCode,
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
                  templateName: fallbackTemplateName,
                  templateLanguageCode: fallbackTemplateLanguageCode,
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

}
