import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseAdminConfig {
  url: string;
  adminKey: string;
  keyType: "secret" | "service_role";
}

export function readSupabaseAdminConfigFromEnv(): SupabaseAdminConfig | undefined {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const adminKey = secretKey || serviceRoleKey;
  if (!url || !adminKey) return undefined;
  return {
    url,
    adminKey,
    keyType: secretKey ? "secret" : "service_role",
  };
}

export function createSupabaseAdminClient(config: SupabaseAdminConfig): SupabaseClient {
  return createClient(config.url, config.adminKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
