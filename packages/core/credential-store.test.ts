import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { CredentialStore } from "./credential-store";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CredentialStore", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cred-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("enabled returns false when no masterPassword", () => {
    const store = new CredentialStore({ dataDir });
    expect(store.enabled).toBe(false);
  });

  test("enabled returns true when masterPassword is set", () => {
    const store = new CredentialStore({ dataDir, masterPassword: "test123" });
    expect(store.enabled).toBe(true);
  });

  test("save throws when disabled", async () => {
    const store = new CredentialStore({ dataDir });
    expect(store.save("example.com", { user: "a" })).rejects.toThrow();
  });

  test("get returns undefined when disabled", async () => {
    const store = new CredentialStore({ dataDir });
    const result = await store.get("example.com");
    expect(result).toBeUndefined();
  });

  test("encrypt → decrypt roundtrip", async () => {
    const store = new CredentialStore({ dataDir, masterPassword: "s3cret!" });
    await store.save("x.com", { username: "alice", password: "p@ss" });
    const creds = await store.get("x.com");
    expect(creds).toEqual({ username: "alice", password: "p@ss" });
  });

  test("wrong master password fails to decrypt", async () => {
    const store1 = new CredentialStore({ dataDir, masterPassword: "correct" });
    await store1.save("x.com", { username: "alice", password: "p@ss" });
    const store2 = new CredentialStore({ dataDir, masterPassword: "wrong" });
    const creds = await store2.get("x.com");
    expect(creds).toBeUndefined();
  });

  test("list returns stored domains", async () => {
    const store = new CredentialStore({ dataDir, masterPassword: "test" });
    await store.save("a.com", { u: "1" });
    await store.save("b.com", { u: "2" });
    const domains = await store.list();
    expect(domains.sort()).toEqual(["a.com", "b.com"]);
  });

  test("delete removes a domain", async () => {
    const store = new CredentialStore({ dataDir, masterPassword: "test" });
    await store.save("a.com", { u: "1" });
    const deleted = await store.delete("a.com");
    expect(deleted).toBe(true);
    const creds = await store.get("a.com");
    expect(creds).toBeUndefined();
  });

  test("delete returns false for unknown domain", async () => {
    const store = new CredentialStore({ dataDir, masterPassword: "test" });
    const deleted = await store.delete("nope.com");
    expect(deleted).toBe(false);
  });

  test("save overwrites existing domain", async () => {
    const store = new CredentialStore({ dataDir, masterPassword: "test" });
    await store.save("x.com", { username: "old" });
    await store.save("x.com", { username: "new" });
    const creds = await store.get("x.com");
    expect(creds).toEqual({ username: "new" });
  });
});
