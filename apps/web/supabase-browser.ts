import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface AuthConfigResponse {
  enabled: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

let authConfigPromise: Promise<AuthConfigResponse | undefined> | undefined;
let supabaseClientPromise: Promise<SupabaseClient | undefined> | undefined;

async function fetchAuthConfig(): Promise<AuthConfigResponse | undefined> {
  if (!authConfigPromise) {
    authConfigPromise = (async () => {
      try {
        const response = await fetch("/api/auth/config", { cache: "no-store" });
        if (!response.ok) return undefined;
        const parsed = await response.json() as AuthConfigResponse;
        if (!parsed.enabled || !parsed.supabaseUrl || !parsed.supabasePublishableKey) {
          return undefined;
        }
        return parsed;
      } catch {
        return undefined;
      }
    })();
  }
  return authConfigPromise;
}

export async function getSupabaseBrowserClient(): Promise<SupabaseClient | undefined> {
  if (!supabaseClientPromise) {
    supabaseClientPromise = (async () => {
      const config = await fetchAuthConfig();
      if (!config?.supabaseUrl || !config.supabasePublishableKey) return undefined;
      return createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    })();
  }
  return supabaseClientPromise;
}

