import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager } from "./runtime-manager";

const originalFetch = globalThis.fetch;

function makeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RuntimeManager", () => {
  let baseDataDir: string;

  beforeEach(() => {
    baseDataDir = mkdtempSync(join(tmpdir(), "runtime-manager-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(baseDataDir, { recursive: true, force: true });
  });

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

    const manager = new RuntimeManager({
      baseDataDir,
      kapsoApiBaseUrl: "https://kapso.test",
      kapsoApiKey: "test-key",
    });

    await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
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
    const manager = new RuntimeManager({ baseDataDir });
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

    const manager = new RuntimeManager({
      baseDataDir,
      kapsoApiBaseUrl: "https://kapso.test",
      kapsoApiKey: "test-key",
    });

    await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
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

    const manager = new RuntimeManager({
      baseDataDir,
      kapsoApiBaseUrl: "https://kapso.test",
      kapsoApiKey: "test-key",
      kapsoFallbackTemplateName: "outside_window_fallback",
      kapsoFallbackTemplateLanguageCode: "es_AR",
    });

    const created = await manager.createOrchestratorWithSetupLink({
      orgId: "org-a",
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
