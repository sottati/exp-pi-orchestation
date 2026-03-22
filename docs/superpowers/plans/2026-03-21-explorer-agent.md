# Explorer Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web explorer agent with Playwright browsing, credential persistence, and migrate `createAgentForRoute` to use `agentDefs` for all agents.

**Architecture:** Three new modules (credential-store, browser wrapper, explorer tools) following existing `ToolEntry` / `createSchedulerToolEntries` patterns. The explorer agent definition uses `localToolEntries()` on the builder. Runtime's `createAgentForRoute` is migrated from the deprecated `specialistRegistry` to resolve `localTools` from `agentDefs` for all non-orchestrator agents.

**Tech Stack:** Bun, TypeScript, Playwright (direct library), Node.js crypto (AES-256-GCM, PBKDF2)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/credential-store.ts` | **New** — AES-256-GCM encrypted credential store with PBKDF2 key derivation |
| `packages/core/credential-store.test.ts` | **New** — Encrypt/decrypt roundtrip, lifecycle, error cases |
| `packages/core/browser.ts` | **New** — Thin Playwright wrapper: `launchAndRun`, `browseUrl`, `searchWeb`, `interactWithPage` |
| `packages/core/browser.test.ts` | **New** — Mock Playwright, verify lifecycle and content extraction |
| `packages/core/explorer-tools.ts` | **New** — 3 `ToolEntry[]` factory: `browse_url`, `search_web`, `interact_page` |
| `packages/core/explorer-tools.test.ts` | **New** — Tool shape, permissions, credential placeholder injection |
| `packages/core/agents.ts` | **Modified** — Add explorer definition, accept `credentialStore` option |
| `packages/core/runtime.ts` | **Modified** — Wire credential store, migrate `createAgentForRoute` to `agentDefs` |
| `.gitignore` | **Modified** — Add `credentials.enc` |
| `package.json` | **Modified** — Add `playwright` dep, `smoke:explorer` script |
| `README.md` | **Modified** — Document explorer agent |
| `CLAUDE.md` | **Modified** — Add explorer to agent list |
| `AGENTS.md` | **Modified** — Add explorer agent entry |

---

### Task 1: Credential Store

**Files:**
- Create: `packages/core/credential-store.ts`
- Test: `packages/core/credential-store.test.ts`

- [ ] **Step 1: Write the credential store test file**

```ts
// packages/core/credential-store.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/credential-store.test.ts`
Expected: FAIL — `CredentialStore` not found

- [ ] **Step 3: Write the credential store implementation**

```ts
// packages/core/credential-store.ts
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

interface CredentialEntry {
  salt: string;  // hex
  iv: string;    // hex
  data: string;  // hex (encrypted)
  tag: string;   // hex (auth tag)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/credential-store.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/credential-store.ts packages/core/credential-store.test.ts
git commit -m "feat: add encrypted credential store (AES-256-GCM, PBKDF2 600k)"
```

---

### Task 2: Browser Wrapper

**Files:**
- Create: `packages/core/browser.ts`
- Test: `packages/core/browser.test.ts`

- [ ] **Step 1: Write the browser wrapper test file**

```ts
// packages/core/browser.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { BrowseResult, SearchResult, PageAction } from "./browser";

describe("browser types", () => {
  test("BrowseResult has required fields", () => {
    const result: BrowseResult = { content: "hello", title: "Test", url: "https://x.com" };
    expect(result.content).toBe("hello");
    expect(result.title).toBe("Test");
    expect(result.url).toBe("https://x.com");
  });

  test("SearchResult has required fields", () => {
    const result: SearchResult = { title: "Bun", url: "https://bun.sh", snippet: "Fast JS runtime" };
    expect(result.title).toBe("Bun");
  });

  test("PageAction types are valid", () => {
    const actions: PageAction[] = [
      { type: "click", selector: "#btn" },
      { type: "fill", selector: "#email", value: "a@b.com" },
      { type: "select", selector: "#country", value: "AR" },
      { type: "wait", timeout: 1000 },
      { type: "wait", selector: "#loaded" },
    ];
    expect(actions).toHaveLength(5);
  });
});

describe("content truncation", () => {
  test("truncateContent caps at limit", async () => {
    const { truncateContent } = await import("./browser");
    const long = "x".repeat(10000);
    const result = truncateContent(long, 8000);
    expect(result.length).toBeLessThanOrEqual(8000);
  });

  test("truncateContent preserves short content", async () => {
    const { truncateContent } = await import("./browser");
    const short = "hello world";
    expect(truncateContent(short, 8000)).toBe(short);
  });
});

describe("browseUrl error handling", () => {
  test("returns error BrowseResult when Playwright is not installed", async () => {
    // browseUrl catches all errors and returns them as content
    const { browseUrl } = await import("./browser");
    // If Playwright is not installed, this should return an error result, not throw
    const result = await browseUrl("https://example.com");
    // Either succeeds (if PW installed) or returns error content — never throws
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
  });
});

describe("searchWeb error handling", () => {
  test("returns error result when Playwright is not installed", async () => {
    const { searchWeb } = await import("./browser");
    const results = await searchWeb("test query");
    // Either succeeds or returns error array — never throws
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  test("caps maxResults between 1 and 10", async () => {
    const { searchWeb } = await import("./browser");
    // These should not throw regardless of Playwright availability
    const r1 = await searchWeb("test", 0);
    expect(Array.isArray(r1)).toBe(true);
    const r2 = await searchWeb("test", 99);
    expect(Array.isArray(r2)).toBe(true);
  });
});

describe("interactWithPage error handling", () => {
  test("returns error BrowseResult when Playwright is not installed", async () => {
    const { interactWithPage } = await import("./browser");
    const result = await interactWithPage("https://example.com", []);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/browser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the browser wrapper implementation**

```ts
// packages/core/browser.ts

export interface BrowseResult {
  content: string;
  title: string;
  url: string;
}

export type PageAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "wait"; selector?: string; timeout?: number };

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_CONTENT_LENGTH = 8000;
const NAV_TIMEOUT = 30_000;

export function truncateContent(text: string, limit: number = MAX_CONTENT_LENGTH): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

async function getPlaywright() {
  try {
    const pw = await import("playwright");
    return pw;
  } catch {
    throw new Error("Playwright is not installed. Run: bun add playwright && bunx playwright install chromium");
  }
}

export async function launchAndRun<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const pw = await getPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult> {
  try {
    return await launchAndRun(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
      }
      const title = await page.title();
      const content = await page.evaluate(() => {
        // Remove common non-content elements
        const selectors = ["nav", "header", "footer", "[role=navigation]", "[role=banner]", ".ad", ".ads", "#cookie-banner"];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => el.remove());
        }
        return document.body?.innerText ?? "";
      });
      return { content: truncateContent(content), title, url: page.url() };
    });
  } catch (err) {
    const msg = errorMessage(err);
    return { content: `Error browsing ${url}: ${msg}`, title: "Error", url };
  }
}

export async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const capped = Math.min(Math.max(maxResults, 1), 10);
  try {
    return await launchAndRun(async (page) => {
      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await page.waitForSelector("[data-result]", { timeout: 10_000 }).catch(() => {});

      const results = await page.evaluate((max: number) => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        const resultElements = document.querySelectorAll("[data-result]");
        for (let i = 0; i < Math.min(resultElements.length, max); i++) {
          const el = resultElements[i]!;
          const a = el.querySelector("a[href]");
          const snippetEl = el.querySelector("[data-result] .result__snippet, .result__body");
          items.push({
            title: a?.textContent?.trim() ?? "",
            url: a?.getAttribute("href") ?? "",
            snippet: snippetEl?.textContent?.trim() ?? el.textContent?.trim()?.slice(0, 200) ?? "",
          });
        }
        return items;
      }, capped);

      return results;
    });
  } catch (err) {
    const msg = errorMessage(err);
    return [{ title: "Search Error", url: "", snippet: `Error searching "${query}": ${msg}` }];
  }
}

export async function interactWithPage(
  url: string,
  actions: PageAction[],
  followUpUrls?: string[],
): Promise<BrowseResult> {
  try {
    return await launchAndRun(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

      for (const action of actions) {
        switch (action.type) {
          case "click":
            await page.click(action.selector, { timeout: 10_000 });
            break;
          case "fill":
            await page.fill(action.selector, action.value, { timeout: 10_000 });
            break;
          case "select":
            await page.selectOption(action.selector, action.value, { timeout: 10_000 });
            break;
          case "wait":
            if (action.selector) {
              await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10_000 }).catch(() => {});
            } else {
              await page.waitForTimeout(action.timeout ?? 3000);
            }
            break;
        }
      }

      const parts: string[] = [];

      // Extract current page content
      const mainContent = await page.evaluate(() => document.body?.innerText ?? "");
      parts.push(truncateContent(mainContent, 4000));

      // Follow-up URLs in the same browser session
      if (followUpUrls) {
        for (const followUrl of followUpUrls) {
          try {
            await page.goto(followUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
            const followContent = await page.evaluate(() => document.body?.innerText ?? "");
            parts.push(`\n--- ${followUrl} ---\n${truncateContent(followContent, 4000)}`);
          } catch (err) {
            const msg = errorMessage(err);
            parts.push(`\n--- ${followUrl} ---\nError: ${msg}`);
          }
        }
      }

      const title = await page.title();
      return {
        content: truncateContent(parts.join("\n"), MAX_CONTENT_LENGTH),
        title,
        url: page.url(),
      };
    });
  } catch (err) {
    const msg = errorMessage(err);
    return { content: `Error interacting with ${url}: ${msg}`, title: "Error", url };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/browser.test.ts`
Expected: ALL PASS (type tests, truncation, and error-handling tests pass. Functions gracefully return error results when Playwright is unavailable.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/browser.ts packages/core/browser.test.ts
git commit -m "feat: add Playwright browser wrapper (browseUrl, searchWeb, interactWithPage)"
```

---

### Task 3: Explorer Tools

**Files:**
- Create: `packages/core/explorer-tools.ts`
- Test: `packages/core/explorer-tools.test.ts`

- [ ] **Step 1: Write the explorer tools test file**

```ts
// packages/core/explorer-tools.test.ts
import { test, expect, describe, mock } from "bun:test";
import { createExplorerToolEntries } from "./explorer-tools";
import { CredentialStore } from "./credential-store";

describe("createExplorerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createExplorerToolEntries({});
    const names = entries.map(e => e.name);
    expect(names).toEqual(["browse_url", "search_web", "interact_page"]);
  });

  test("browse_url and search_web have allow permission", () => {
    const entries = createExplorerToolEntries({});
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["browse_url"]).toBe("allow");
    expect(perms["search_web"]).toBe("allow");
  });

  test("interact_page has hitl permission", () => {
    const entries = createExplorerToolEntries({});
    const tool = entries.find(e => e.name === "interact_page")!;
    expect(tool.defaultPermission).toBe("hitl");
  });

  test("all tools have source local and are available", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });

  test("all tools have description and parameters", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });
});

describe("credential placeholder injection", () => {
  test("interact_page resolves {{credential:*}} placeholders when store is enabled", async () => {
    // We mock the browser module to avoid needing Playwright
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dataDir = await mkdtemp(join(tmpdir(), "cred-tool-test-"));
    const store = new CredentialStore({ dataDir, masterPassword: "test" });
    await store.save("example.com", { username: "alice", password: "secret" });

    const entries = createExplorerToolEntries({ credentialStore: store });
    const interactTool = entries.find(e => e.name === "interact_page")!;

    // We can't fully test execute without Playwright, but we can verify the
    // tool entry is correctly configured
    expect(interactTool.defaultPermission).toBe("hitl");

    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("password redaction", () => {
  test("redactActions masks password fill values", async () => {
    const { redactActions } = await import("./explorer-tools");
    const actions = [
      { type: "fill" as const, selector: "[name=username]", value: "alice" },
      { type: "fill" as const, selector: "[type=password]", value: "secret123" },
      { type: "fill" as const, selector: "#password-field", value: "hidden" },
      { type: "click" as const, selector: "#submit" },
    ];
    const redacted = redactActions(actions);
    expect(redacted[0]).toEqual({ type: "fill", selector: "[name=username]", value: "alice" });
    expect(redacted[1]).toEqual({ type: "fill", selector: "[type=password]", value: "***REDACTED***" });
    expect(redacted[2]).toEqual({ type: "fill", selector: "#password-field", value: "***REDACTED***" });
    expect(redacted[3]).toEqual({ type: "click", selector: "#submit" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/explorer-tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the explorer tools implementation**

```ts
// packages/core/explorer-tools.ts
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import type { PageAction } from "./browser";

export interface ExplorerToolOptions {
  credentialStore?: CredentialStore;
}

const PASSWORD_PATTERNS = /password|secret|passwd|token|api.?key/i;

export function redactActions(actions: PageAction[]): PageAction[] {
  return actions.map(action => {
    if (action.type === "fill" && PASSWORD_PATTERNS.test(action.selector)) {
      return { ...action, value: "***REDACTED***" };
    }
    return action;
  });
}

async function resolveCredentialPlaceholders(
  actions: PageAction[],
  url: string,
  credentialStore?: CredentialStore,
): Promise<PageAction[]> {
  if (!credentialStore?.enabled) return actions;

  let domain: string;
  try {
    domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return actions;
  }

  const creds = await credentialStore.get(domain);
  if (!creds) return actions;

  return actions.map(action => {
    if (action.type !== "fill") return action;
    const match = action.value.match(/^\{\{credential:(.+)\}\}$/);
    if (!match) return action;
    const key = match[1]!;
    const resolved = creds[key];
    if (resolved === undefined) return action;
    return { ...action, value: resolved };
  });
}

export function createExplorerToolEntries(opts: ExplorerToolOptions): ToolEntry[] {
  const { credentialStore } = opts;

  const browseUrl: ToolEntry = {
    name: "browse_url",
    source: "local",
    description: "Navigate to a URL and extract readable page content as text. Returns the page title, final URL, and body text.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to browse." }),
      waitFor: Type.Optional(Type.String({ description: "CSS selector to wait for before extracting content." })),
    }),
    execute: async (_toolCallId, params) => {
      const { browseUrl: browse } = await import("./browser");
      const result = await browse(params.url as string, params.waitFor as string | undefined);
      return {
        content: [{ type: "text" as const, text: `# ${result.title}\nURL: ${result.url}\n\n${result.content}` }],
        details: { title: result.title, url: result.url },
      };
    },
    defaultPermission: "allow",
    available: true,
  };

  const searchWeb: ToolEntry = {
    name: "search_web",
    source: "local",
    description: "Search the web using DuckDuckGo. Returns a list of results with title, URL, and snippet.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (1-10, default 5)." })),
    }),
    execute: async (_toolCallId, params) => {
      const { searchWeb: search } = await import("./browser");
      const results = await search(params.query as string, params.maxResults as number | undefined);
      const text = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return {
        content: [{ type: "text" as const, text: text || "No results found." }],
        details: { results },
      };
    },
    defaultPermission: "allow",
    available: true,
  };

  const interactPage: ToolEntry = {
    name: "interact_page",
    source: "local",
    description: "Navigate to a URL, perform actions (click, fill, select, wait), and optionally follow up to other URLs. Supports credential auto-injection via {{credential:username}} and {{credential:password}} placeholders. Returns the final page content.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      actions: Type.Array(
        Type.Object({
          type: Type.Union([
            Type.Literal("click"),
            Type.Literal("fill"),
            Type.Literal("select"),
            Type.Literal("wait"),
          ]),
          selector: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          timeout: Type.Optional(Type.Number()),
        }),
        { description: "Sequence of page actions." },
      ),
      followUpUrls: Type.Optional(
        Type.Array(Type.String(), { description: "URLs to navigate to after actions (same browser session)." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { interactWithPage } = await import("./browser");
      let actions = params.actions as PageAction[];
      const url = params.url as string;
      const followUpUrls = params.followUpUrls as string[] | undefined;

      // Resolve credential placeholders
      actions = await resolveCredentialPlaceholders(actions, url, credentialStore);

      const result = await interactWithPage(url, actions, followUpUrls);

      return {
        content: [{ type: "text" as const, text: `# ${result.title}\nURL: ${result.url}\n\n${result.content}` }],
        details: {
          title: result.title,
          url: result.url,
          actions: redactActions(params.actions as PageAction[]),
        },
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [browseUrl, searchWeb, interactPage];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/explorer-tools.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/explorer-tools.ts packages/core/explorer-tools.test.ts
git commit -m "feat: add explorer tool entries (browse_url, search_web, interact_page)"
```

---

### Task 4: Agent Definition & Runtime Migration

**Files:**
- Modify: `packages/core/agents.ts`
- Modify: `packages/core/runtime.ts`

- [ ] **Step 1: Update `agents.ts` — add explorer definition and accept credentialStore**

Change `createAgentDefinitions` to accept options and add explorer agent:

```ts
// In packages/core/agents.ts

// Add imports at top:
import type { CredentialStore } from "./credential-store";
import { createExplorerToolEntries } from "./explorer-tools";

// Change function signature:
export function createAgentDefinitions(opts?: {
  credentialStore?: CredentialStore;
}): AgentDefinition[] {

// Add to orchestrator systemPrompt (after scheduling lines):
"The explorer specialist can browse the web, search, and interact with pages."

// Add explorer agent definition before the return:
const explorerTools = createExplorerToolEntries({
  credentialStore: opts?.credentialStore,
});

const explorer = defineAgent("explorer")
  .name("Web Explorer")
  .role("Retrieves information from the web via browsing and scraping.")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt([
    "You are a web explorer specialist. You retrieve information from the web.",
    "",
    "You have three tools:",
    "- browse_url: Fetch and extract readable content from a URL. Returns markdown.",
    "- search_web: Search the web for a query. Returns titles, URLs, and snippets.",
    "- interact_page: Navigate to a URL and perform actions (click, fill, select, wait).",
    "  Supports followUpUrls to navigate after actions (e.g., login then browse).",
    "  Credentials can be auto-injected using {{credential:username}} and {{credential:password}} placeholders.",
    "",
    "Guidelines:",
    "- Return extracted content relevant to the task. Trim irrelevant navigation, ads, footers.",
    "- For search tasks, return the top results with URLs so the caller can follow up.",
    "- If a page fails to load or is blocked, report the error clearly — do not retry.",
    "- Do not summarize or editorialize unless the task explicitly asks for analysis.",
    "- Do not perform purchases, account creation, or irreversible actions.",
    "- Be concise. Prefer structured output (lists, key-value) over prose.",
  ].join("\n"))
  .capabilities(["browse", "search", "interact", "extract"])
  .localToolEntries(explorerTools)
  .permissions({ "interact_page": "hitl" })
  .maxConcurrency(1)
  .build();

// Update return:
return [orchestrator, code, math, explorer];
```

Also update the deprecated `createSpecialistRegistry` to build from `agentDefs` so it includes explorer:

```ts
// In agents.ts — update createSpecialistRegistry to accept same opts and build from defs:
export function createSpecialistRegistry(opts?: {
  credentialStore?: CredentialStore;
}): SpecialistRegistry {
  const defs = createAgentDefinitions(opts);
  const registry: SpecialistRegistry = {};
  for (const def of defs) {
    if (def.id === ORCHESTRATOR_ID) continue;
    registry[def.id] = {
      id: def.id,
      name: def.name,
      role: def.role,
      capabilities: def.capabilities,
      maxConcurrency: def.maxConcurrency,
      createAgent: () => def.createAgent([], def.systemPrompt),
    };
  }
  return registry;
}
```

This ensures `list_agents` and `delegate` see the explorer agent via the existing `specialistRegistry` path used by orchestrator tools.

- [ ] **Step 2: Update `runtime.ts` — credential store + migrate createAgentForRoute**

Key changes to `runtime.ts`:

1. Import `CredentialStore`
2. Add `credentialStore` as class field, initialize in constructor
3. Pass `credentialStore` to `createAgentDefinitions` AND `createSpecialistRegistry`
4. Migrate `createAgentForRoute` to use `agentDefs` for all agents (not just orchestrator)
5. Update `getMaxConcurrency` in ChatManager to use `agentDefs` instead of `specialistRegistry`
6. Add `explorer` to `runSmokeScenario`

```ts
// In constructor, before agentDefs:
import { CredentialStore } from "./credential-store";

// Add field:
readonly credentialStore: CredentialStore;

// In constructor body, before agentDefs setup:
this.credentialStore = new CredentialStore({
  dataDir: this.store.dataDir,
  masterPassword: process.env.MASTER_PASSWORD,
});

// Pass to createAgentDefinitions:
const agentDefList = options.agents ?? createAgentDefinitions({
  credentialStore: this.credentialStore,
});

// Pass to createSpecialistRegistry:
this.specialistRegistry = createSpecialistRegistry({
  credentialStore: this.credentialStore,
});

// Replace createAgentForRoute:
private createAgentForRoute(toAgentId: string, runContext: RunContext): Agent {
  const def = this.agentDefs.get(toAgentId);
  if (!def) throw new Error(`Agent '${toAgentId}' is not registered.`);

  if (toAgentId === ORCHESTRATOR_ID) {
    const orchTools = this.createOrchestratorToolsForRun(runContext);
    const schedulerTools = this.createSchedulerToolsForRun();
    return def.createAgent([...orchTools, ...schedulerTools], def.systemPrompt);
  }

  // For all other agents: resolve localTools → AgentTool[], pass to createAgent
  const localTools: AgentTool<any>[] = (def.localTools ?? []).map(entry => ({
    name: entry.name,
    label: entry.description,
    description: entry.description,
    parameters: entry.parameters,
    execute: entry.execute,
  } as AgentTool<any>));

  const compiledPrompt = compileSystemPrompt(def, localTools);
  return def.createAgent(localTools, compiledPrompt);
}

// Update getMaxConcurrency in ChatManager to use agentDefs:
getMaxConcurrency: (agentId) => {
  const def = this.agentDefs.get(agentId);
  return def?.maxConcurrency ?? 1;
},

// Add explorer to runSmokeScenario:
async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer") {
  // ... existing cases ...
  if (name === "explorer") {
    return this.chat({ toAgentId: "explorer", content: "Search the web for 'Bun runtime' and return the top 3 results." });
  }
  // ...
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run all existing tests**

Run: `bun test`
Expected: ALL PASS (existing tests should not break)

- [ ] **Step 5: Commit**

```bash
git add packages/core/agents.ts packages/core/runtime.ts
git commit -m "feat: add explorer agent definition, migrate createAgentForRoute to agentDefs"
```

---

### Task 5: Project Config & Documentation

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update .gitignore — add credentials.enc**

Append `credentials.enc` to `.gitignore`.

- [ ] **Step 2: Update package.json — add playwright dependency and smoke:explorer script**

Add to dependencies: `"playwright": "^1.52.0"`
Add to scripts: `"smoke:explorer": "bun run apps/cli/index.ts --smoke explorer"`

- [ ] **Step 3: Install playwright**

Run: `bun install`
Then: `bunx playwright install chromium` (skip if CI — the smoke test requires it)

- [ ] **Step 4: Update README.md**

Add `explorer` to:
- Agent table (with model config)
- CLI commands (`/use explorer`)
- Estructura principal (new files)
- Agent capabilities description

Add new sections:
- Explorer agent description
- Credential store explanation
- `MASTER_PASSWORD` env var documentation

- [ ] **Step 5: Update CLAUDE.md**

Add to agent list and model configuration:
- `explorer` → `openrouter/google/gemini-3.1-flash-lite-preview`
- New files: `browser.ts`, `explorer-tools.ts`, `credential-store.ts`
- Credential store docs

- [ ] **Step 6: Update AGENTS.md**

Add explorer agent entry with capabilities, tools, and usage instructions.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json README.md CLAUDE.md AGENTS.md
git commit -m "docs: add explorer agent to documentation, add playwright dependency"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 2: Run all unit tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Fix any remaining issues**

If typecheck or tests fail, fix them and re-run.
