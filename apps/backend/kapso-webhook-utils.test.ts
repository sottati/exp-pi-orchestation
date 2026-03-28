import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature, WebhookIdempotencyWindow } from "./kapso-webhook-utils";

describe("kapso-webhook-utils", () => {
  test("verifyWebhookSignature validates HMAC signatures", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const secret = "test-secret";
    const validSignature = createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(verifyWebhookSignature(rawBody, validSignature, secret)).toBe(true);
    expect(verifyWebhookSignature(rawBody, "bad-signature", secret)).toBe(false);
    expect(verifyWebhookSignature(rawBody, null, secret)).toBe(false);
  });

  test("verifyWebhookSignature bypasses checks when no secret is configured", () => {
    expect(verifyWebhookSignature("{}", null, undefined)).toBe(true);
    expect(verifyWebhookSignature("{}", "anything", undefined)).toBe(true);
  });

  test("WebhookIdempotencyWindow deduplicates keys within TTL", () => {
    const dedupe = new WebhookIdempotencyWindow(1_000);

    expect(dedupe.markSeen("abc", 10_000)).toBe(false);
    expect(dedupe.markSeen("abc", 10_500)).toBe(true);
    expect(dedupe.markSeen("abc", 11_100)).toBe(false);
  });
});

