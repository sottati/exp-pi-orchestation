import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./credential-store";
import { createCredentialToolEntries } from "./credential-tools";

function extractText(result: any): string {
  return result.content[0]?.text ?? "";
}

describe("createCredentialToolEntries", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "pi-agent-creds-"));
  });

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("returns request_credentials with hitl permission", () => {
    const entries = createCredentialToolEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("request_credentials");
    expect(entries[0]?.defaultPermission).toBe("hitl");
  });

  test("returns error when credential store is disabled", async () => {
    const tool = createCredentialToolEntries()[0]!;
    const result = await tool.execute("tc1", {
      domain: "google",
      fields: [{ key: "client_id" }],
      values: { client_id: "abc" },
    });
    expect(extractText(result)).toContain("Credential store is disabled");
  });

  test("stores submitted values and preserves existing fields", async () => {
    const store = new CredentialStore({
      dataDir,
      masterPassword: "test-master-password",
    });
    await store.save("google", {
      client_secret: "keep-this",
      refresh_token: "old-token",
    });

    const tool = createCredentialToolEntries({ credentialStore: store })[0]!;
    const result = await tool.execute("tc2", {
      domain: "google",
      fields: [
        { key: "client_id", required: true, secret: false },
        { key: "refresh_token", required: true, secret: true },
      ],
      values: {
        client_id: "new-client-id",
        refresh_token: "new-refresh-token",
      },
    });

    expect(extractText(result)).toContain("Stored credentials for 'google'");
    const saved = await store.get("google");
    expect(saved).toEqual({
      client_secret: "keep-this",
      client_id: "new-client-id",
      refresh_token: "new-refresh-token",
    });
  });
});
