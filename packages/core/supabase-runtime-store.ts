import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChannelDeliveryEvent,
  CommunicationIntentLog,
  OrchestratorChannelConfig,
} from "./contracts";
import type { SecretCrypto } from "./secret-crypto";

interface OrgRow {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  config_version: number | null;
}

interface OrchestratorChannelRow {
  org_id: string;
  user_id: string;
  orchestrator_id: string;
  phone_number_id: string | null;
  owner_number: string;
  active: boolean;
  kapso_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChannelEventRow {
  org_id: string;
  orchestrator_id: string;
  channel: "ui" | "cli" | "whatsapp";
  contact: string;
  direction: "inbound" | "outbound";
  status: ChannelDeliveryEvent["status"];
  message_id: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  event_ts: string;
}

interface CommunicationIntentRow {
  id: string;
  org_id: string;
  orchestrator_id: string;
  from_number: string;
  expected_owner_number: string;
  reason: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface MembershipRow {
  org_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
}

interface EnvSecretRow {
  org_id: string;
  user_id: string | null;
  env_key: string;
  env_value: string;
  updated_at: string;
}

function toEpochMillis(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export interface OrgConfigRecord {
  orgId: string;
  config: Record<string, unknown>;
  configVersion: number;
}

export interface SupabaseRuntimeStoreOptions {
  client: SupabaseClient;
  crypto?: SecretCrypto;
}

export class SupabaseRuntimeStore {
  private readonly client: SupabaseClient;
  private readonly crypto?: SecretCrypto;

  constructor(opts: SupabaseRuntimeStoreOptions) {
    this.client = opts.client;
    this.crypto = opts.crypto;
  }

  async getOrgConfig(orgId: string): Promise<OrgConfigRecord | undefined> {
    const { data, error } = await this.client
      .from("orgs")
      .select("id, config, config_version")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load org config: ${error.message}`);
    if (!data) return undefined;
    const row = data as OrgRow;
    return {
      orgId: row.id,
      config: row.config ?? {},
      configVersion: row.config_version ?? 1,
    };
  }

  async listMembershipOrgIds(userId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("org_memberships")
      .select("org_id")
      .eq("user_id", userId);
    if (error) throw new Error(`Failed to read memberships: ${error.message}`);
    return [...new Set((data ?? []).map((row) => String((row as MembershipRow).org_id)))].sort();
  }

  async isMemberOfOrg(userId: string, orgId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("org_memberships")
      .select("org_id")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to verify membership: ${error.message}`);
    return !!data;
  }

  async listOrchestratorChannels(orgId: string): Promise<OrchestratorChannelConfig[]> {
    const { data, error } = await this.client
      .from("orchestrator_channels")
      .select("org_id, user_id, orchestrator_id, phone_number_id, owner_number, active, kapso_customer_id, created_at, updated_at")
      .eq("org_id", orgId)
      .order("orchestrator_id", { ascending: true });
    if (error) throw new Error(`Failed to list channels: ${error.message}`);
    return (data ?? []).map((row) => {
      const typed = row as OrchestratorChannelRow;
      return {
        orgId: typed.org_id,
        userId: typed.user_id,
        orchestratorId: typed.orchestrator_id,
        phoneNumberId: typed.phone_number_id ?? undefined,
        ownerNumber: typed.owner_number,
        active: !!typed.active,
        kapsoCustomerId: typed.kapso_customer_id ?? "",
        createdAt: toEpochMillis(typed.created_at),
        updatedAt: toEpochMillis(typed.updated_at),
      };
    });
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
    const payload = {
      org_id: input.orgId,
      user_id: input.userId,
      orchestrator_id: input.orchestratorId,
      owner_number: input.ownerNumber,
      kapso_customer_id: input.kapsoCustomerId,
      phone_number_id: input.phoneNumberId ?? null,
      active: input.active ?? true,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.client
      .from("orchestrator_channels")
      .upsert(payload, { onConflict: "org_id,orchestrator_id" })
      .select("org_id, user_id, orchestrator_id, phone_number_id, owner_number, active, kapso_customer_id, created_at, updated_at")
      .single();
    if (error) throw new Error(`Failed to upsert channel: ${error.message}`);
    const row = data as OrchestratorChannelRow;
    return {
      orgId: row.org_id,
      userId: row.user_id,
      orchestratorId: row.orchestrator_id,
      phoneNumberId: row.phone_number_id ?? undefined,
      ownerNumber: row.owner_number,
      active: !!row.active,
      kapsoCustomerId: row.kapso_customer_id ?? "",
      createdAt: toEpochMillis(row.created_at),
      updatedAt: toEpochMillis(row.updated_at),
    };
  }

  async bindPhoneNumberByCustomer(customerId: string, phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const { data: existing, error: readError } = await this.client
      .from("orchestrator_channels")
      .select("org_id, user_id, orchestrator_id")
      .eq("kapso_customer_id", customerId)
      .maybeSingle();
    if (readError) throw new Error(`Failed to find channel by customer: ${readError.message}`);
    if (!existing) return undefined;

    const { data, error } = await this.client
      .from("orchestrator_channels")
      .update({
        phone_number_id: phoneNumberId,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", String((existing as { org_id: string }).org_id))
      .eq("user_id", String((existing as { user_id: string }).user_id))
      .eq("orchestrator_id", String((existing as { orchestrator_id: string }).orchestrator_id))
      .select("org_id, user_id, orchestrator_id, phone_number_id, owner_number, active, kapso_customer_id, created_at, updated_at")
      .single();
    if (error) throw new Error(`Failed to bind phone number: ${error.message}`);
    const row = data as OrchestratorChannelRow;
    return {
      orgId: row.org_id,
      userId: row.user_id,
      orchestratorId: row.orchestrator_id,
      phoneNumberId: row.phone_number_id ?? undefined,
      ownerNumber: row.owner_number,
      active: !!row.active,
      kapsoCustomerId: row.kapso_customer_id ?? "",
      createdAt: toEpochMillis(row.created_at),
      updatedAt: toEpochMillis(row.updated_at),
    };
  }

  async findChannelByPhoneNumberId(phoneNumberId: string): Promise<OrchestratorChannelConfig | undefined> {
    const { data, error } = await this.client
      .from("orchestrator_channels")
      .select("org_id, user_id, orchestrator_id, phone_number_id, owner_number, active, kapso_customer_id, created_at, updated_at")
      .eq("phone_number_id", phoneNumberId)
      .maybeSingle();
    if (error) throw new Error(`Failed to find channel by phone number: ${error.message}`);
    if (!data) return undefined;
    const row = data as OrchestratorChannelRow;
    return {
      orgId: row.org_id,
      userId: row.user_id,
      orchestratorId: row.orchestrator_id,
      phoneNumberId: row.phone_number_id ?? undefined,
      ownerNumber: row.owner_number,
      active: !!row.active,
      kapsoCustomerId: row.kapso_customer_id ?? "",
      createdAt: toEpochMillis(row.created_at),
      updatedAt: toEpochMillis(row.updated_at),
    };
  }

  async findChannelByKapsoCustomerId(customerId: string): Promise<OrchestratorChannelConfig | undefined> {
    const { data, error } = await this.client
      .from("orchestrator_channels")
      .select("org_id, user_id, orchestrator_id, phone_number_id, owner_number, active, kapso_customer_id, created_at, updated_at")
      .eq("kapso_customer_id", customerId)
      .maybeSingle();
    if (error) throw new Error(`Failed to find channel by customer id: ${error.message}`);
    if (!data) return undefined;
    const row = data as OrchestratorChannelRow;
    return {
      orgId: row.org_id,
      userId: row.user_id,
      orchestratorId: row.orchestrator_id,
      phoneNumberId: row.phone_number_id ?? undefined,
      ownerNumber: row.owner_number,
      active: !!row.active,
      kapsoCustomerId: row.kapso_customer_id ?? "",
      createdAt: toEpochMillis(row.created_at),
      updatedAt: toEpochMillis(row.updated_at),
    };
  }

  async appendChannelEvent(event: ChannelDeliveryEvent): Promise<void> {
    const payload = {
      org_id: event.orgId,
      orchestrator_id: event.orchestratorId,
      channel: event.channel,
      contact: event.contact,
      direction: event.direction,
      status: event.status,
      message_id: event.messageId ?? null,
      error: event.error ?? null,
      metadata: event.metadata ?? {},
      event_ts: new Date(event.timestamp).toISOString(),
    };
    const { error } = await this.client.from("channel_events").insert(payload);
    if (error) {
      if (error.code === "23505" && event.messageId) {
        return;
      }
      throw new Error(`Failed to append channel event: ${error.message}`);
    }
  }

  async listChannelEvents(orgId: string): Promise<ChannelDeliveryEvent[]> {
    const { data, error } = await this.client
      .from("channel_events")
      .select("org_id, orchestrator_id, channel, contact, direction, status, message_id, error, metadata, event_ts")
      .eq("org_id", orgId)
      .order("event_ts", { ascending: true });
    if (error) throw new Error(`Failed to list channel events: ${error.message}`);
    return (data ?? []).map((row, index) => {
      const typed = row as ChannelEventRow;
      return {
        eventId: `${typed.org_id}:${typed.orchestrator_id}:${typed.message_id ?? index}:${typed.event_ts}`,
        orgId: typed.org_id,
        orchestratorId: typed.orchestrator_id,
        channel: typed.channel,
        contact: typed.contact,
        direction: typed.direction,
        status: typed.status,
        timestamp: toEpochMillis(typed.event_ts),
        messageId: typed.message_id ?? undefined,
        error: typed.error ?? undefined,
        metadata: typed.metadata ?? {},
      };
    });
  }

  async appendCommunicationIntent(intent: CommunicationIntentLog): Promise<void> {
    const payload = {
      id: intent.intentId,
      org_id: intent.orgId,
      orchestrator_id: intent.orchestratorId,
      from_number: intent.fromNumber,
      expected_owner_number: intent.expectedOwnerNumber,
      reason: intent.reason,
      metadata: intent.metadata ?? {},
      created_at: new Date(intent.timestamp).toISOString(),
    };
    const { error } = await this.client.from("communication_intents").insert(payload);
    if (error) throw new Error(`Failed to append communication intent: ${error.message}`);
  }

  async listCommunicationIntents(orgId: string): Promise<CommunicationIntentLog[]> {
    const { data, error } = await this.client
      .from("communication_intents")
      .select("id, org_id, orchestrator_id, from_number, expected_owner_number, reason, metadata, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list communication intents: ${error.message}`);
    return (data ?? []).map((row) => {
      const typed = row as CommunicationIntentRow;
      return {
        intentId: typed.id,
        orgId: typed.org_id,
        orchestratorId: typed.orchestrator_id,
        fromNumber: typed.from_number,
        expectedOwnerNumber: typed.expected_owner_number,
        reason: typed.reason,
        timestamp: toEpochMillis(typed.created_at),
        metadata: typed.metadata ?? {},
      };
    });
  }

  async resolveEnvOverride(key: string, opts?: { orgId?: string; userId?: string; orchestratorId?: string }): Promise<string | undefined> {
    const envKey = key.trim();
    if (!envKey) return undefined;
    const orgId = opts?.orgId?.trim();
    if (!orgId) return undefined;
    const userId = opts?.userId?.trim();

    if (userId) {
      const { data, error } = await this.client
        .from("env_secrets")
        .select("org_id, user_id, env_key, env_value, updated_at")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .eq("env_key", envKey)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to resolve env override '${envKey}' for user '${userId}': ${error.message}`);
      if (data) {
        const row = data as EnvSecretRow;
        return row.env_value;
      }
    }

    const { data, error } = await this.client
      .from("env_secrets")
      .select("org_id, user_id, env_key, env_value, updated_at")
      .eq("org_id", orgId)
      .is("user_id", null)
      .eq("env_key", envKey)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve env override '${envKey}': ${error.message}`);
    if (data) {
      const row = data as EnvSecretRow;
      return row.env_value;
    }
    return undefined;
  }
}
