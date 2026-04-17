const AUTH_TOKEN_STORAGE_KEYS = ["PI_AUTH_TOKEN", "SUPABASE_ACCESS_TOKEN", "sb-access-token"] as const;

function extractAccessToken(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractAccessToken(item);
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = record.access_token;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    for (const item of Object.values(record)) {
      const candidate = extractAccessToken(item);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

export function readAuthToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const queryToken = new URLSearchParams(window.location.search).get("token")?.trim();
  if (queryToken) return queryToken;

  for (const key of AUTH_TOKEN_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key)?.trim();
    if (value) return value;
  }

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const token = extractAccessToken(parsed);
      if (token) return token;
    } catch {
      // Ignore malformed entries and continue scanning.
    }
  }

  return undefined;
}

