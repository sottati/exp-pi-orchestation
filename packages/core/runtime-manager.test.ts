import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  OrchestratorChannelConfig,
} from "./contracts";
import type { CredentialStorePort } from "./credential-store";
import type { CredentialContext } from "./credential-store";
import { RuntimeManager } from "./runtime-manager";
import type { SupabaseRuntimeStore } from "./supabase-runtime-store";

const originalFetch = globalThis.fetch;

function makeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

class InMemoryRuntimeStore {
  private readonly orgConfigs = new Map<string, { config: Record<string, unknown>; configVersion: number }>();
  private readonly channelsByOrg = new Map<string, OrchestratorChannelConfig[]>();
  private readonly channelEventsByOrg = new Map<string, ChannelDeliveryEvent[]>();
  private readonly communicationIntentsByOrg = new Map<string, CommunicationIntentLog[]>();

  setOrgConfig(orgId: string, config: Record<string, unknown>, configVersion = 1): void {
    this.orgConfigs.set(orgId, { config, configVersion });
  }

  async getOrgConfig(orgId: string): Promise<{ orgId: string; config: Record<string, unknown>; configVersion: number }> {
    const found = this.orgConfigs.get(orgId);
    if (found) {
      return { orgId, config: found.config, configVersion: found.configVersion };
    }
    return { orgId, config: {}, configVersion: 1 };
  }

  async listMembershipOrgIds(_userId: string): Promise<string[]> {
    return [];
  }

  async isMemberOfOrg(_userId: string, _orgId: string): Promise<boolean> {
    return true;
  }

  async listOrchestratorChannels(orgId: string): Promise<OrchestratorChannelConfig[]> {
    return [...(this.channelsByOrg.get(orgId) ?? [])].sort((a, b) => a.orchestratorId.localeCompare(b.orchestratorId));
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
    const existing = (this.channelsByOrg.get(input.orgId) ?? []).find((row) => row.orchestratorId === input.orchestratorId);
    const nowTs = Date.now();
    const next: OrchestratorChannelConfig = {
      orgId: input.orgId,
      userId: input.userId,
      orchestratorId: input.orchestratorId,
      ownerNumber: input.ownerNumber,
      kapsoCustomerId: input.kapsoCustomerId,
      phoneNumberId: input.phoneNumberId ?? existing?.phoneNumberId,
      active: input.active ?? true,
      createdAt: existing?.createdAt ?? nowTs,
      updatedAt: nowTs,
    };
    const rows = (this.channelsByOrg.get(input.orgId) ?? []).filter((row) => row.orchestratorId !== input.orchestratorId);
    rows.push(next);
    this.channelsByOrg.set(input.orgId, rows);
    return next;
  }

  async bindPhoneNumberByCustomer(customerId: string, phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    for (const [orgId, rows] of this.channelsByOrg.entries()) {
      const index = rows.findIndex((row) => row.kapsoCustomerId === customerId);
      if (index < 0) continue;
      const updated: OrchestratorChannelConfig = {
        ...rows[index]!,
        phoneNumberId,
        updatedAt: Date.now(),
      };
      const nextRows = [...rows];
      nextRows[index] = updated;
      this.channelsByOrg.set(orgId, nextRows);
      return updated;
    }
    return undefined;
  }

  async findChannelByPhoneNumberId(phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    for (const rows of this.channelsByOrg.values()) {
      const found = rows.find((row) => row.phoneNumberId === phoneNumberId);
      if (found) return found;
    }
    return undefined;
  }

  async findChannelByKapsoCustomerId(customerId: string): Promise<OrchestratorChannelConfig | undefined> {
    for (const rows of this.channelsByOrg.values()) {
      const found = rows.find((row) => row.kapsoCustomerId === customerId);
      if (found) return found;
    }
    return undefined;
  }

  async appendChannelEvent(event: ChannelDeliveryEvent): Promise<void> {
    const rows = this.channelEventsByOrg.get(event.orgId) ?? [];
    if (event.messageId && rows.some((row) => row.messageId === event.messageId)) return;
    rows.push(event);
    rows.sort((a, b) => a.timestamp - b.timestamp);
    this.channelEventsByOrg.set(event.orgId, rows);
  }

  async listChannelEvents(orgId: string): Promise<ChannelDeliveryEvent[]> {
    return [...(this.channelEventsByOrg.get(orgId) ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  }

  async appendCommunicationIntent(intent: CommunicationIntentLog): Promise<void> {
    const rows = this.communicationIntentsByOrg.get(intent.orgId) ?? [];
    rows.push(intent);
    rows.sort((a, b) => b.timestamp - a.timestamp);
    this.communicationIntentsByOrg.set(intent.orgId, rows);
  }

  async listCommunicationIntents(orgId: string): Promise<CommunicationIntentLog[]> {
    return [...(this.communicationIntentsByOrg.get(orgId) ?? [])].sort((a, b) => b.timestamp - a.timestamp);
  }

  async resolveEnvOverride(_key: string, _opts?: { orgId?: string; userId?: string; orchestratorId?: string }): Promise<string | undefined> {
    return undefined;
  }
}

const noopCredentialStoreFactory = (): CredentialStorePort => ({
  enabled: false,
  async save() {
    // no-op for tests
  },
  async get() {
    return undefined;
  },
  async list() {
    return [];
  },
  async delete() {
    return true;
  },
  async runWithContext<T>(_context: CredentialContext, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
});

describe("RuntimeManager", () => {
  let baseDataDir: string;
  let runtimeStore: InMemoryRuntimeStore;

  beforeEach(() => {
    baseDataDir = mkdtempSync(join(tmpdir(), "runtime-manager-test-"));
    runtimeStore = new InMemoryRuntimeStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(baseDataDir, { recursive: true, force: true });
  });

  function createManager(opts?: { kapsoApiKey?: string; kapsoFallbackTemplateName?: string; kapsoFallbackTemplateLanguageCode?: string }) {
    return new RuntimeManager({
      baseDataDir,
      kapsoApiBaseUrl: "https://kapso.test",
      kapsoApiKey: opts?.kapsoApiKey,
      kapsoFallbackTemplateName: opts?.kapsoFallbackTemplateName,
      kapsoFallbackTemplateLanguageCode: opts?.kapsoFallbackTemplateLanguageCode,
      runtimeStore: runtimeStore as unknown as SupabaseRuntimeStore,
      credentialStoreFactory: noopCredentialStoreFactory,
    });
  }

  test("owner_number mismatch is blocked and logged as communication intent", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/platform/v1/customers")) {
        return makeJsonResponse({ data: { id: "cust_1" } });
      }
      if (url.includes("/platform/v1/customers/cust_1/setup_links")) {
        return makeJsonResponse({ data: { url: "https://kapso.test/setup-link" } });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    const manager = createManager({ kapsoApiKey: "test-key" });

    await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
      userId: "user-1",
      orchestratorId: "sales",
      ownerNumber: "+5491111111111",
    });

    const result = await manager.processExternalMessage({
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      channel: "whatsapp",
      contact: "+5492222222222",
      content: "hola",
      timestamp: Date.now(),
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("owner_number_mismatch");

    const intents = await manager.listCommunicationIntents("org-a");
    expect(intents.length).toBe(1);
    expect(intents[0]?.fromNumber).toBe("+5492222222222");
    expect(intents[0]?.expectedOwnerNumber).toBe("+5491111111111");
  });

  test("recordChannelEvent updates conversation index", async () => {
    const manager = createManager();
    const ts = Date.now();

    await manager.recordChannelEvent({
      eventId: "evt_1",
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      channel: "whatsapp",
      contact: "+5491111111111",
      direction: "inbound",
      status: "received",
      timestamp: ts,
      metadata: { text: "Hola desde WhatsApp" },
    });

    const conversations = await manager.listConversations("org-a", "orchestrator:sales");
    expect(conversations.length).toBe(1);
    expect(conversations[0]?.contact).toBe("+5491111111111");
    expect(conversations[0]?.preview).toBe("Hola desde WhatsApp");
    expect(conversations[0]?.lastStatus).toBe("received");
  });

  test("upsertOrchestratorChannel stores reusable mapping", async () => {
    const manager = createManager();

    const created = await manager.upsertOrchestratorChannel({
      orgId: "default",
      userId: "user-1",
      orchestratorId: "main",
      ownerNumber: "+54 9 11 6606-6821",
      kapsoCustomerId: "cust_sandbox",
      phoneNumberId: "pn_1",
    });

    expect(created.orgId).toBe("default");
    expect(created.orchestratorId).toBe("orchestrator:main");
    expect(created.ownerNumber).toBe("+5491166066821");
    expect(created.kapsoCustomerId).toBe("cust_sandbox");
    expect(created.phoneNumberId).toBe("pn_1");

    const updated = await manager.upsertOrchestratorChannel({
      orgId: "default",
      userId: "user-1",
      orchestratorId: "main",
      ownerNumber: "+5491166066821",
      kapsoCustomerId: "cust_sandbox_2",
      active: false,
    });

    expect(updated.kapsoCustomerId).toBe("cust_sandbox_2");
    expect(updated.phoneNumberId).toBe("pn_1");
    expect(updated.active).toBe(false);
    expect(updated.createdAt).toBe(created.createdAt);

    const orchestrators = await manager.listOrchestrators("default");
    expect(orchestrators.length).toBe(1);
    expect(orchestrators[0]?.kapsoCustomerId).toBe("cust_sandbox_2");
    expect(orchestrators[0]?.phoneNumberId).toBe("pn_1");
  });

  test("processExternalMessage preserves FIFO order per conversation", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/platform/v1/customers")) {
        return makeJsonResponse({ data: { id: "cust_fifo" } });
      }
      if (url.includes("/platform/v1/customers/cust_fifo/setup_links")) {
        return makeJsonResponse({ data: { url: "https://kapso.test/setup-link" } });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    const manager = createManager({ kapsoApiKey: "test-key" });

    await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
      userId: "user-1",
      orchestratorId: "sales",
      ownerNumber: "+5491111111111",
    });

    const orgRuntime = await manager.getOrgRuntime("org-a");
    const seenContentOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    (orgRuntime.runtime as unknown as { chat: (input: { content: string }) => Promise<unknown> }).chat = async (
      input,
    ) => {
      seenContentOrder.push(input.content);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (input.content === "first") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      inFlight -= 1;
      return {
        answer: `ok:${input.content}`,
        durationMs: 1,
        threadId: "thread_fifo",
        runContext: {
          sessionId: "default",
          runId: `run_${input.content}`,
          turnId: `turn_${input.content}`,
          initiator: "external",
          orgId: "org-a",
          channel: "ui",
          contact: "+5491111111111",
          orchestratorId: "orchestrator:sales",
        },
      };
    };

    const first = manager.processExternalMessage({
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      channel: "ui",
      contact: "+5491111111111",
      content: "first",
      timestamp: Date.now(),
    });

    const second = manager.processExternalMessage({
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      channel: "ui",
      contact: "+5491111111111",
      content: "second",
      timestamp: Date.now() + 1,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(seenContentOrder).toEqual(["first", "second"]);
    expect(maxInFlight).toBe(1);
    expect(firstResult.answer).toBe("ok:first");
    expect(secondResult.answer).toBe("ok:second");
  });

  test("whatsapp text send falls back to template when outside session window", async () => {
    const messageBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/platform/v1/customers")) {
        return makeJsonResponse({ data: { id: "cust_tpl" } });
      }
      if (url.includes("/platform/v1/customers/cust_tpl/setup_links")) {
        return makeJsonResponse({ data: { url: "https://kapso.test/setup-link" } });
      }
      if (url.includes("/meta/whatsapp/v24.0/pn_1/messages")) {
        const body = String(init?.body ?? "");
        messageBodies.push(body);
        if (body.includes("\"type\":\"text\"")) {
          return new Response("{\"error\":\"Outside allowed window\"}", { status: 400 });
        }
        if (body.includes("\"type\":\"template\"")) {
          return makeJsonResponse({ messages: [{ id: "wamid.template.1" }] });
        }
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    const manager = createManager({
      kapsoApiKey: "test-key",
      kapsoFallbackTemplateName: "outside_window_fallback",
      kapsoFallbackTemplateLanguageCode: "es_AR",
    });

    const created = await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
      userId: "user-1",
      orchestratorId: "sales",
      ownerNumber: "+5491111111111",
    });
    await manager.bindPhoneNumberByCustomer(created.channelConfig.kapsoCustomerId, "pn_1");

    const orgRuntime = await manager.getOrgRuntime("org-a");
    (orgRuntime.runtime as unknown as { chat: (input: { content: string }) => Promise<unknown> }).chat = async (
      input,
    ) => ({
      answer: `ok:${input.content}`,
      durationMs: 1,
      threadId: "thread_tpl",
      runContext: {
        sessionId: "default",
        runId: "run_tpl",
        turnId: "turn_tpl",
        initiator: "external",
        orgId: "org-a",
        channel: "whatsapp",
        contact: "+5491111111111",
        orchestratorId: "orchestrator:sales",
      },
    });

    const result = await manager.processExternalMessage({
      orgId: "org-a",
      orchestratorId: "orchestrator:sales",
      channel: "whatsapp",
      contact: "+5491111111111",
      content: "hola",
      timestamp: Date.now(),
    });

    expect(result.blocked).toBe(false);
    expect(messageBodies.length).toBe(2);
    expect(messageBodies[0]).toContain("\"type\":\"text\"");
    expect(messageBodies[1]).toContain("\"type\":\"template\"");
    expect(messageBodies[1]).toContain("\"name\":\"outside_window_fallback\"");
    expect(messageBodies[1]).toContain("\"code\":\"es_AR\"");

    const events = await manager.listChannelEvents("org-a");
    const fallbackDelivered = events.find((event) => event.status === "delivered" && event.metadata?.deliveryMode === "template_fallback");
    expect(fallbackDelivered).toBeDefined();
  });
});
