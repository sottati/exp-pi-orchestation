import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

interface CredentialEntry {
  salt: string;
  iv: string;
  data: string;
  tag: string;
}

interface StoreData {
  [domain: string]: CredentialEntry;
}

const ALGORITHM = "aes-256-gcm";
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

export class CredentialStore {
  private readonly masterPassword?: string;
  private readonly filePath: string;

  constructor(opts: { dataDir: string; masterPassword?: string }) {
    this.masterPassword = opts.masterPassword;
    this.filePath = join(opts.dataDir, "credentials.enc");
  }

  get enabled(): boolean {
    return !!this.masterPassword;
  }

  async save(domain: string, credentials: Record<string, string>): Promise<void> {
    if (!this.masterPassword) throw new Error("Credential store is disabled (no MASTER_PASSWORD).");
    const salt = randomBytes(SALT_LENGTH);
    const key = pbkdf2Sync(this.masterPassword, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = JSON.stringify(credentials);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const entry: CredentialEntry = {
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      data: encrypted.toString("hex"),
      tag: tag.toString("hex"),
    };
    const store = await this.readStore();
    store[domain] = entry;
    await this.writeStore(store);
  }

  async get(domain: string): Promise<Record<string, string> | undefined> {
    if (!this.masterPassword) return undefined;
    const store = await this.readStore();
    const entry = store[domain];
    if (!entry) return undefined;
    try {
      const salt = Buffer.from(entry.salt, "hex");
      const key = pbkdf2Sync(this.masterPassword, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
      const iv = Buffer.from(entry.iv, "hex");
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "hex")),
        decipher.final(),
      ]);
      return JSON.parse(decrypted.toString("utf8"));
    } catch {
      return undefined;
    }
  }

  async list(): Promise<string[]> {
    const store = await this.readStore();
    return Object.keys(store);
  }

  async delete(domain: string): Promise<boolean> {
    const store = await this.readStore();
    if (!(domain in store)) return false;
    delete store[domain];
    await this.writeStore(store);
    return true;
  }

  private async readStore(): Promise<StoreData> {
    try {
      const file = Bun.file(this.filePath);
      if (!(await file.exists())) return {};
      return JSON.parse(await file.text()) as StoreData;
    } catch {
      return {};
    }
  }

  private async writeStore(data: StoreData): Promise<void> {
    const dir = join(this.filePath, "..");
    await mkdir(dir, { recursive: true });
    await Bun.write(this.filePath, JSON.stringify(data, null, 2));
  }
}
