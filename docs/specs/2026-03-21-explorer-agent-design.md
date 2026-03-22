# Explorer Agent Design

Date: 2026-03-21
Status: Approved (rev 2 — post spec-review fixes)

## Summary

Add a web explorer specialist agent to the multi-agent runtime. The explorer retrieves information from the web using Playwright (direct library, not MCP). It exposes 3 high-level tools and includes an encrypted credential store for automated/scheduled tasks.

This spec also migrates `createAgentForRoute` to use `agentDefs` + `localToolEntries` for all agents, replacing the deprecated `specialistRegistry` path.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Playwright integration | Direct library (not MCP) | No external process, works in .exe distribution without MCP server |
| Tool granularity | 3 high-level tools (no raw Playwright fallback) | Fewer LLM turns, more predictable, cheaper tokens |
| Credential persistence | AES-256-GCM encrypted JSON file | Enables unattended cron jobs; master password via `MASTER_PASSWORD` env var |
| Master password delivery | `.env` file (Bun auto-loads) | Works for both interactive and unattended (cron) scenarios |
| Browser lifecycle | Per-operation (launch → execute → close) | Simpler, no long-lived processes, ~2-3s overhead acceptable |
| Communication | Only orchestrator delegates to explorer | Explorer has no delegation tools, no access to other agents |

## New Files

### 1. `packages/core/browser.ts` — Playwright Wrapper

Thin abstraction over Playwright's browser lifecycle.

```ts
interface BrowseResult {
  content: string;   // markdown of visible page content
  title: string;
  url: string;
}

// Launch headless Chromium, run callback, close browser.
async function launchAndRun<T>(fn: (page: Page) => Promise<T>): Promise<T>;

// Navigate to URL, extract readable content as markdown.
async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult>;

// Navigate to URL, perform action sequence, return final page state.
async function interactWithPage(
  url: string,
  actions: PageAction[],
): Promise<BrowseResult>;

// Search DuckDuckGo, extract results.
async function searchWeb(
  query: string,
  maxResults?: number,
): Promise<SearchResult[]>;

type PageAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "wait"; selector?: string; timeout?: number };

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
```

**Error handling:**
- Navigation timeout → return error message, don't throw
- DNS failure → return error message
- Selector not found → return error with available selectors hint
- All errors caught and returned as text content (tools never throw)

**Content extraction:**
- Use `page.evaluate()` to extract `document.body.innerText`
- Strip navigation, ads, footers via heuristic (remove elements with common ad/nav selectors before extraction)
- Truncate to 8000 chars to stay within LLM context limits

### 2. `packages/core/explorer-tools.ts` — Tool Entries

Follows the `createSchedulerToolEntries` pattern.

```ts
interface ExplorerToolOptions {
  credentialStore?: CredentialStore;
}

function createExplorerToolEntries(opts: ExplorerToolOptions): ToolEntry[];
```

**Tools:**

#### `browse_url`
- **Parameters:** `url: string` (required), `waitFor?: string` (CSS selector to wait for)
- **Returns:** Markdown content of the page
- **Permission:** `allow`
- **Behavior:** `launchAndRun` → navigate → extract content → close

#### `search_web`
- **Parameters:** `query: string` (required), `maxResults?: number` (default 5, max 10)
- **Returns:** JSON array of `{title, url, snippet}`
- **Permission:** `allow`
- **Behavior:** `launchAndRun` → navigate to DuckDuckGo → extract results → close

#### `interact_page`
- **Parameters:** `url: string`, `actions: PageAction[]`, `followUpUrls?: string[]`
- **Returns:** Final page content after all actions and follow-up navigations + action results summary
- **Permission:** `hitl`
- **Behavior:** `launchAndRun` → navigate to `url` → execute actions sequentially → for each `followUpUrls`, navigate and extract → return combined content → close. This keeps the browser session alive across the full sequence (login → navigate → extract) within a single tool call.
- **Credential auto-injection:** When the execute function runs, it extracts the domain from `url`. If `credentialStore.enabled` and a match exists, the stored credentials are available. The LLM does NOT call the credential store directly — the orchestrator passes credentials as part of the task context, or `interact_page` auto-fills when `actions` reference credential placeholders like `{{credential:username}}` and `{{credential:password}}`.
- **Security:** Redact `value` field for `fill` actions where selector matches password/secret patterns in trace output. Never log credential values. Placeholder values (`{{credential:*}}`) are resolved at execution time and never appear in traces.

### 3. `packages/core/credential-store.ts` — Encrypted Credentials

```ts
class CredentialStore {
  constructor(opts: { dataDir: string; masterPassword?: string });

  // Returns true if master password is set and store is usable
  get enabled(): boolean;

  // Save credentials for a domain (overwrites existing)
  async save(domain: string, credentials: Record<string, string>): Promise<void>;

  // Retrieve credentials for a domain (returns undefined if not found or disabled)
  async get(domain: string): Promise<Record<string, string> | undefined>;

  // List all stored domains
  async list(): Promise<string[]>;

  // Delete credentials for a domain
  async delete(domain: string): Promise<boolean>;
}
```

**Encryption:**
- Algorithm: AES-256-GCM
- Key derivation: PBKDF2 with SHA-256, 600k iterations, random salt (OWASP 2023+ recommendation)
- Storage format: `{ salt: hex, iv: hex, data: hex }` per domain entry
- File location: `data/<sessionId>/credentials.enc`
- If `MASTER_PASSWORD` not in env → `enabled` returns false, `get()` returns undefined, `save()` throws

**File in `.gitignore`:** `credentials.enc`

### 4. Changes to `packages/core/agents.ts`

Add explorer agent definition:

```ts
// Explorer tools are created at definition time (not per-run like orchestrator)
const explorerTools = createExplorerToolEntries({ credentialStore });

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
```

Add to the returned array: `return [orchestrator, code, math, explorer];`

The `createAgentDefinitions` function signature changes to accept optional dependencies:

```ts
function createAgentDefinitions(opts?: {
  credentialStore?: CredentialStore;
}): AgentDefinition[];
```

### 5. Changes to `packages/core/runtime.ts`

**Credential store initialization:**

- Create `CredentialStore` in constructor with `MASTER_PASSWORD` from `process.env`
- Pass `credentialStore` to `createAgentDefinitions({ credentialStore })`

**Migrate `createAgentForRoute` to use `agentDefs`:**

Replace the deprecated `specialistRegistry` path. The new routing logic for ALL agents (not just orchestrator):

```ts
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
```

This resolves the issue where non-orchestrator agents were getting empty tool arrays. Explorer's `localToolEntries` (set via builder) are now properly resolved and passed.

**HITL middleware for explorer tools:**

The `interact_page` tool has `hitl` permission. Since tools now flow through `localTools` on the agent definition, the runtime wraps them via `wrapTool` before passing to `createAgent`. This ensures the HITL handler is called for `interact_page`.

**Update orchestrator system prompt** to mention explorer:

Add to orchestrator's prompt: `"The explorer specialist can browse the web, search, and interact with pages."` so the LLM knows when to delegate to it.

## Data Flow

### Interactive browsing
```
User → Orchestrator: "busca info sobre Bun runtime"
  → delegate("explorer", "search and browse info about Bun runtime")
    → Explorer: search_web("Bun runtime") → [{title, url, snippet}, ...]
    → Explorer: browse_url("https://bun.sh") → markdown content
    → Explorer returns combined answer
  → Orchestrator: get_chat_result → formats and returns to user
```

### Scheduled monitoring with credentials

```text
User → Orchestrator: "monitorea X trends cada 6 horas"
  → HITL: "necesito credenciales de X"
  → User provides credentials
  → Orchestrator: credentialStore.save("x.com", {username, password})
  → Orchestrator: schedule_task(target: "explorer", cron: "0 */6 * * *",
      task: "login to x.com and extract trending topics")
  → Every 6h:
    → Scheduler → runtime.chat({toAgentId: "explorer", content: task})
      → Explorer: interact_page(
          url: "x.com/login",
          actions: [
            {fill: "[name=username]", value: "{{credential:username}}"},
            {fill: "[name=password]", value: "{{credential:password}}"},
            {click: "[type=submit]"},
            {wait: {timeout: 3000}}
          ],
          followUpUrls: ["x.com/explore"]
        )
      → Single browser session: login → wait → navigate → extract → close
      → Returns trending content as markdown
```

## Security

- Credentials encrypted at rest with AES-256-GCM
- `MASTER_PASSWORD` only in `.env` (never persisted by the runtime)
- `interact_page` is `hitl` by default — user must approve interactive actions
- Password field values redacted in traces (matched by selector pattern: `[type=password]`, `*password*`, `*secret*`)
- `credentials.enc` added to `.gitignore`
- No credential values in thread envelopes or JSONL persistence

## Testing

### `browser.test.ts`
- Mock playwright's `chromium.launch()` to return fake browser/page
- Verify `launchAndRun` calls `browser.close()` even on error
- Verify `browseUrl` returns truncated markdown
- Verify `searchWeb` parses DuckDuckGo result format
- Verify `interactWithPage` executes actions in sequence

### `explorer-tools.test.ts`
- Mock `browser.ts` functions
- Verify `browse_url` returns correct `ToolEntry` format
- Verify `search_web` caps `maxResults` at 10
- Verify `interact_page` has `hitl` permission
- Verify password redaction in action descriptions

### `credential-store.test.ts`
- Encrypt → decrypt roundtrip with correct master password
- Wrong master password → decryption fails gracefully
- `enabled` returns false when no `MASTER_PASSWORD`
- `save` → `get` → `list` → `delete` lifecycle
- Concurrent access safety (atomic writes)

## Dependencies

New package dependency:

```sh
bun add playwright
```

Post-install (for Chromium, ~400MB download — required once per machine):

```sh
bunx playwright install chromium
```

Note: CI/CD on Linux may also need `bunx playwright install --with-deps chromium` for system libraries.

## Files Changed Summary

| File | Change |
|---|---|
| `packages/core/browser.ts` | **New** — Playwright wrapper |
| `packages/core/explorer-tools.ts` | **New** — 3 high-level tool entries |
| `packages/core/credential-store.ts` | **New** — Encrypted credential store |
| `packages/core/agents.ts` | **Modified** — Add explorer definition, accept `credentialStore` option |
| `packages/core/runtime.ts` | **Modified** — Migrate `createAgentForRoute` to `agentDefs`, wire credential store, wrap localTools with middleware |
| `packages/core/browser.test.ts` | **New** — Browser wrapper tests |
| `packages/core/explorer-tools.test.ts` | **New** — Explorer tools tests |
| `packages/core/credential-store.test.ts` | **New** — Credential store tests |
| `.gitignore` | **Modified** — Add `credentials.enc` |
| `package.json` | **Modified** — Add `playwright` dependency, add `smoke:explorer` script |
| `README.md` | **Modified** — Document explorer agent, new CLI capabilities |
| `CLAUDE.md` | **Modified** — Add explorer to agent list, credential store docs |
| `AGENTS.md` | **Modified** — Add explorer agent entry |
