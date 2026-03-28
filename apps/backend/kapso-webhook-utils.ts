import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_DEDUPE_TTL_MS = 10 * 60_000;

export function verifyWebhookSignature(rawBody: string, signature: string | null, secret?: string): boolean {
  if (!secret) return true;
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(expected, "utf-8");
  const right = Buffer.from(signature.trim(), "utf-8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class WebhookIdempotencyWindow {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_DEDUPE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  markSeen(idempotencyKey?: string | null, nowTs = Date.now()): boolean {
    if (!idempotencyKey) return false;

    for (const [key, timestamp] of this.seen.entries()) {
      if (nowTs - timestamp > this.ttlMs) {
        this.seen.delete(key);
      }
    }

    if (this.seen.has(idempotencyKey)) return true;
    this.seen.set(idempotencyKey, nowTs);
    return false;
  }
}

