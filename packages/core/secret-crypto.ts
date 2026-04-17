import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function deriveAesKey(masterKey: string): Buffer {
  const trimmed = masterKey.trim();

  if (trimmed.startsWith("base64:")) {
    const decoded = Buffer.from(trimmed.slice("base64:".length), "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex");
    if (decoded.length === KEY_LENGTH) return decoded;
  }

  return createHash("sha256").update(trimmed).digest();
}

export class SecretCrypto {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    if (!masterKey.trim()) {
      throw new Error("MASTER_ENCRYPTION_KEY is required.");
    }
    this.key = deriveAesKey(masterKey);
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(payload.iv, "base64"),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }
}

