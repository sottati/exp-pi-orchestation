import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialContext, CredentialStorePort } from "./credential-store";
import type { SecretCrypto } from "./secret-crypto";

interface CredentialRow {
  org_id: string;
  orchestrator_id: string | null;
  provider: string;
  field_name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  key_version: number;
}

interface EnvSecretRow {
  org_id: string;
  user_id: string | null;
  env_key: string;
  env_value: string;
  updated_at: string;
}

export interface SupabaseCredentialStoreOptions {
  client: SupabaseClient;
  crypto: SecretCrypto;
  orgId: string;
  keyVersion?: number;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

const ENV_FALLBACK_BY_DOMAIN: Record<string, Record<string, string>> = {
  openrouter: {
    apiKey: "OPENROUTER_API_KEY",
  },
  google: {
    client_id: "GOOGLE_CLIENT_ID",
    client_secret: "GOOGLE_CLIENT_SECRET",
    refresh_token: "GOOGLE_REFRESH_TOKEN",
  },
  gemini: {
    apiKey: "GEMINI_API_KEY",
  },
  canva: {
    apiKey: "CANVA_API_KEY",
  },
  figma: {
    accessToken: "FIGMA_ACCESS_TOKEN",
  },
};

export class SupabaseCredentialStore implements CredentialStorePort {
  readonly enabled = true;

  private readonly client: SupabaseClient;
  private readonly crypto: SecretCrypto;
  private readonly orgId: string;
  private readonly keyVersion: number;
  private readonly contextStorage = new AsyncLocalStorage<CredentialContext>();

  constructor(opts: SupabaseCredentialStoreOptions) {
    this.client = opts.client;
    this.crypto = opts.crypto;
    this.orgId = opts.orgId;
    this.keyVersion = opts.keyVersion ?? 1;
  }

  private activeContext(): CredentialContext {
    return this.contextStorage.getStore() ?? { orgId: this.orgId };
  }

  private activeOrchestratorId(): string | undefined {
    const raw = this.activeContext().orchestratorId;
    const normalized = raw?.trim();
    return normalized || undefined;
  }

  async runWithContext<T>(context: CredentialContext, fn: () => Promise<T>): Promise<T> {
    const current = this.activeContext();
    return this.contextStorage.run(
      {
        orgId: this.orgId,
        userId: context.userId ?? current.userId,
        orchestratorId: context.orchestratorId ?? current.orchestratorId,
      },
      fn,
    );
  }

  private activeUserId(): string | undefined {
    const raw = this.activeContext().userId;
    const normalized = raw?.trim();
    return normalized || undefined;
  }

  private async resolveEnvSecrets(envKeys: string[]): Promise<Record<string, string>> {
    const cleaned = [...new Set(envKeys.map((key) => key.trim()).filter(Boolean))];
    if (cleaned.length === 0) return {};

    const { data, error } = await this.client
      .from("env_secrets")
      .select("org_id, user_id, env_key, env_value, updated_at")
      .eq("org_id", this.orgId)
      .in("env_key", cleaned)
      .order("updated_at", { ascending: false });
    if (error) {
      throw new Error(`Failed to resolve env-backed credentials: ${error.message}`);
    }

    const rows = (data ?? []) as EnvSecretRow[];
    const activeUserId = this.activeUserId();
    const out: Record<string, string> = {};
    for (const envKey of cleaned) {
      const userScoped = activeUserId
        ? rows.find((row) => row.env_key === envKey && row.user_id === activeUserId)
        : undefined;
      const orgScoped = rows.find((row) => row.env_key === envKey && row.user_id === null);
      const fallback = rows.find((row) => row.env_key === envKey);
      const selected = userScoped ?? orgScoped ?? fallback;
      if (!selected) continue;
      const value = selected.env_value?.trim();
      if (!value) continue;
      out[envKey] = value;
    }
    return out;
  }

  private async resolveEnvFallback(domain: string): Promise<Record<string, string>> {
    const mapping = ENV_FALLBACK_BY_DOMAIN[domain];
    if (!mapping) return {};
    const envValues = await this.resolveEnvSecrets(Object.values(mapping));
    const out: Record<string, string> = {};
    for (const [fieldName, envKey] of Object.entries(mapping)) {
      const value = envValues[envKey];
      if (value) out[fieldName] = value;
    }
    return out;
  }

  async save(domain: string, credentials: Record<string, string>): Promise<void> {
    const provider = normalizeDomain(domain);
    if (!provider) throw new Error("Credential domain is required.");
    const orchestratorId = this.activeOrchestratorId();

    const deleteQuery = this.client
      .from("org_credentials")
      .delete()
      .eq("org_id", this.orgId)
      .eq("provider", provider);
    const { error: deleteError } = orchestratorId
      ? await deleteQuery.eq("orchestrator_id", orchestratorId)
      : await deleteQuery.is("orchestrator_id", null);
    if (deleteError) {
      throw new Error(`Failed to replace credentials for '${provider}': ${deleteError.message}`);
    }

    const entries = Object.entries(credentials);
    if (entries.length === 0) return;

    const rows: CredentialRow[] = entries.map(([field, value]) => {
      const encrypted = this.crypto.encrypt(value);
      return {
        org_id: this.orgId,
        orchestrator_id: orchestratorId ?? null,
        provider,
        field_name: field,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        key_version: this.keyVersion,
      };
    });

    const { error: insertError } = await this.client.from("org_credentials").insert(rows);
    if (insertError) {
      throw new Error(`Failed to save credentials for '${provider}': ${insertError.message}`);
    }
  }

  private async loadScopeRows(domain: string, orchestratorId?: string): Promise<CredentialRow[]> {
    const baseQuery = this.client
      .from("org_credentials")
      .select("org_id, orchestrator_id, provider, field_name, ciphertext, iv, tag, key_version")
      .eq("org_id", this.orgId)
      .eq("provider", domain);

    const { data, error } = orchestratorId
      ? await baseQuery.eq("orchestrator_id", orchestratorId)
      : await baseQuery.is("orchestrator_id", null);

    if (error) {
      throw new Error(`Failed to load credentials for '${domain}': ${error.message}`);
    }
    return (data ?? []) as CredentialRow[];
  }

  async get(domain: string): Promise<Record<string, string> | undefined> {
    const provider = normalizeDomain(domain);
    if (!provider) return undefined;
    const envFallback = await this.resolveEnvFallback(provider);

    const orgRows = await this.loadScopeRows(provider);
    const orchestratorId = this.activeOrchestratorId();
    const scopedRows = orchestratorId
      ? await this.loadScopeRows(provider, orchestratorId)
      : [];

    const rowsByField = new Map<string, CredentialRow>();
    for (const row of orgRows) {
      rowsByField.set(row.field_name, row);
    }
    for (const row of scopedRows) {
      rowsByField.set(row.field_name, row);
    }

    if (rowsByField.size === 0) {
      return Object.keys(envFallback).length > 0 ? envFallback : undefined;
    }
    const out: Record<string, string> = { ...envFallback };
    for (const [field, row] of rowsByField.entries()) {
      out[field] = this.crypto.decrypt({
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
      });
    }
    return out;
  }

  async list(): Promise<string[]> {
    const orchestratorId = this.activeOrchestratorId();
    const baseQuery = this.client
      .from("org_credentials")
      .select("provider")
      .eq("org_id", this.orgId);

    const { data: orgRows, error: orgError } = await baseQuery.is("orchestrator_id", null);
    if (orgError) {
      throw new Error(`Failed to list credentials: ${orgError.message}`);
    }

    const providers = new Set<string>((orgRows ?? []).map((row) => String((row as { provider?: string }).provider ?? "")));
    if (orchestratorId) {
      const { data: scopedRows, error: scopedError } = await this.client
        .from("org_credentials")
        .select("provider")
        .eq("org_id", this.orgId)
        .eq("orchestrator_id", orchestratorId);
      if (scopedError) {
        throw new Error(`Failed to list scoped credentials: ${scopedError.message}`);
      }
      for (const row of scopedRows ?? []) {
        providers.add(String((row as { provider?: string }).provider ?? ""));
      }
    }

    const envKeysByDomain = Object.entries(ENV_FALLBACK_BY_DOMAIN);
    const uniqueEnvKeys = [...new Set(envKeysByDomain.flatMap(([, mapping]) => Object.values(mapping)))];
    const envValues = await this.resolveEnvSecrets(uniqueEnvKeys);
    for (const [domain, mapping] of envKeysByDomain) {
      if (Object.values(mapping).some((envKey) => Boolean(envValues[envKey]))) {
        providers.add(domain);
      }
    }

    return [...providers].filter(Boolean).sort();
  }

  async delete(domain: string): Promise<boolean> {
    const provider = normalizeDomain(domain);
    if (!provider) return false;
    const orchestratorId = this.activeOrchestratorId();

    const deleteQuery = this.client
      .from("org_credentials")
      .delete()
      .eq("org_id", this.orgId)
      .eq("provider", provider);
    const { error } = orchestratorId
      ? await deleteQuery.eq("orchestrator_id", orchestratorId)
      : await deleteQuery.is("orchestrator_id", null);
    if (error) {
      throw new Error(`Failed to delete credentials for '${provider}': ${error.message}`);
    }
    return true;
  }
}
