# Marketing Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a "marketing" specialist agent — a virtual CMO focused on SEO & growth — with keyword research, competitor analysis, on-page SEO audits, content strategy, and Google Sheets as its data backend.

**Architecture:** New `packages/core/marketing-tools.ts` module with 4 local tools. Cherry-picks `search_web` + `browse_url` from explorer tools. Direct delegation to `writer`, `explorer`, and `secretary` agents with `maxDepth: 2`. Agent registered in `agents.ts`, UI personality in `types.ts`, smoke test in runtime + CLI.

**Tech Stack:** Playwright (via Node bridge + `safeLaunchAndRun`), Google Sheets API (`googleapis`), TypeBox schemas, existing `browser.ts` and `google-auth.ts` utilities.

---

### Task 0: Create `marketing-tools.ts` — seo_audit tool

**Files:**
- Create: `packages/core/marketing-tools.ts`

**Step 1: Create the file with imports, options interface, helper, and the `seo_audit` tool**

```ts
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { errorMessage } from "./errors";
import { safeLaunchAndRun } from "./browser";
import { getGoogleAuth } from "./google-auth";
import { google } from "googleapis";

export interface MarketingToolOptions {
  credentialStore?: CredentialStore;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function getSheetId(): string {
  const id = process.env.MARKETING_SHEET_ID;
  if (!id) {
    throw new Error(
      "MARKETING_SHEET_ID not configured — set env var or store in CredentialStore domain 'marketing'"
    );
  }
  return id;
}

export function createMarketingToolEntries(opts?: MarketingToolOptions): ToolEntry[] {
  const seoAudit: ToolEntry = {
    name: "seo_audit",
    source: "local",
    description:
      "Run an on-page SEO audit on a URL. Extracts title, meta tags, heading hierarchy, image alt texts, links, structured data, and page timing.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to audit" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      try {
        return await safeLaunchAndRun(async (page) => {
          const startMs = Date.now();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const loadTimeMs = Date.now() - startMs;

          const seoData = await page.evaluate(() => {
            const getMeta = (name: string) =>
              (document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement)?.content ?? null;
            const getMetaOg = (prop: string) =>
              (document.querySelector(`meta[property="${prop}"]`) as HTMLMetaElement)?.content ?? null;

            const headings: Record<string, string[]> = {};
            for (const tag of ["h1", "h2", "h3"]) {
              headings[tag] = Array.from(document.querySelectorAll(tag)).map(
                (el) => (el as HTMLElement).innerText.trim()
              );
            }

            const images = Array.from(document.querySelectorAll("img"));
            const altTexts = images.map((img) => ({
              src: img.src?.slice(0, 120),
              alt: img.alt || null,
            }));
            const missingAlt = images.filter((img) => !img.alt).length;

            const links = Array.from(document.querySelectorAll("a[href]"));
            const origin = window.location.origin;
            let internalLinks = 0;
            let externalLinks = 0;
            for (const a of links) {
              try {
                const href = new URL((a as HTMLAnchorElement).href, origin);
                if (href.origin === origin) internalLinks++;
                else externalLinks++;
              } catch { /* skip invalid */ }
            }

            const schemaScripts = Array.from(
              document.querySelectorAll('script[type="application/ld+json"]')
            );
            const schemaMarkup = schemaScripts.map((s) => {
              try { return JSON.parse(s.textContent ?? ""); }
              catch { return null; }
            }).filter(Boolean);

            return {
              title: document.title,
              metaDescription: getMeta("description"),
              metaKeywords: getMeta("keywords"),
              ogTitle: getMetaOg("og:title"),
              ogDescription: getMetaOg("og:description"),
              ogImage: getMetaOg("og:image"),
              canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href ?? null,
              headings,
              altTexts: altTexts.slice(0, 20),
              missingAlt,
              totalImages: images.length,
              internalLinks,
              externalLinks,
              schemaMarkup,
            };
          });

          // Identify issues
          const issues: string[] = [];
          if (!seoData.title) issues.push("Missing <title> tag");
          if (!seoData.metaDescription) issues.push("Missing meta description");
          if (!seoData.headings.h1?.length) issues.push("Missing <h1> tag");
          if ((seoData.headings.h1?.length ?? 0) > 1) issues.push("Multiple <h1> tags");
          if (seoData.missingAlt > 0) issues.push(`${seoData.missingAlt} images missing alt text`);
          if (!seoData.canonical) issues.push("Missing canonical URL");
          if (!seoData.ogTitle) issues.push("Missing og:title");
          if (!seoData.ogDescription) issues.push("Missing og:description");

          const result = { ...seoData, loadTimeMs, issues, url: page.url() };

          const summary = [
            `# SEO Audit: ${seoData.title || "(no title)"}`,
            `URL: ${page.url()}`,
            `Load time: ${loadTimeMs}ms`,
            ``,
            `## Meta`,
            `- Title: ${seoData.title || "MISSING"}`,
            `- Description: ${seoData.metaDescription || "MISSING"}`,
            `- Keywords: ${seoData.metaKeywords || "none"}`,
            `- Canonical: ${seoData.canonical || "MISSING"}`,
            `- OG Title: ${seoData.ogTitle || "MISSING"}`,
            ``,
            `## Headings`,
            `- H1 (${seoData.headings.h1?.length ?? 0}): ${seoData.headings.h1?.join(", ") || "MISSING"}`,
            `- H2 (${seoData.headings.h2?.length ?? 0}): ${seoData.headings.h2?.slice(0, 5).join(", ") || "none"}`,
            `- H3 (${seoData.headings.h3?.length ?? 0})`,
            ``,
            `## Images & Links`,
            `- Images: ${seoData.totalImages} total, ${seoData.missingAlt} missing alt`,
            `- Internal links: ${seoData.internalLinks}`,
            `- External links: ${seoData.externalLinks}`,
            ``,
            `## Schema Markup`,
            seoData.schemaMarkup.length > 0
              ? seoData.schemaMarkup.map((s: any) => `- ${s["@type"] || "unknown type"}`).join("\n")
              : "- None found",
            ``,
            `## Issues (${issues.length})`,
            issues.length > 0 ? issues.map((i) => `- ${i}`).join("\n") : "- No issues found",
          ].join("\n");

          return textResult(summary, result);
        });
      } catch (err) {
        return textResult(
          `Error auditing ${url}: ${errorMessage(err)}. ` +
          `Ensure Playwright is installed (bunx playwright install chromium) and node is in PATH.`
        );
      }
    },
  };

  // ... (Sheets tools added in Task 1)

  return [seoAudit];
}
```

**Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS (no errors in marketing-tools.ts)

**Step 3: Commit**

```bash
git add packages/core/marketing-tools.ts
git commit -m "feat(marketing): add marketing-tools.ts with seo_audit tool"
```

---

### Task 1: Add Google Sheets CRUD tools to `marketing-tools.ts`

**Files:**
- Modify: `packages/core/marketing-tools.ts`

**Step 1: Add the three Sheets CRUD tools inside `createMarketingToolEntries`, before the return statement**

Replace `return [seoAudit];` with the three tools + updated return.

The three tools follow the same pattern — CRUD on a named sheet tab. Each uses `getSheetId()` for the spreadsheet ID and `getGoogleAuth()` for credentials.

```ts
  const marketingKeywords: ToolEntry = {
    name: "marketing_keywords",
    source: "local",
    description: "CRUD operations on the Keywords tracking sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("remove"),
      ], { description: "Operation to perform" }),
      keyword: Type.Optional(Type.String({ description: "Keyword (required for add/update/remove)" })),
      data: Type.Optional(Type.Object({
        volume: Type.Optional(Type.String({ description: "Search volume" })),
        difficulty: Type.Optional(Type.String({ description: "Keyword difficulty" })),
        position: Type.Optional(Type.String({ description: "Current ranking position" })),
        notes: Type.Optional(Type.String({ description: "Additional notes" })),
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Keywords",
        headers: ["Keyword", "Volume", "Difficulty", "Position", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Keyword",
        keyValue: params.keyword as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  const marketingCompetitors: ToolEntry = {
    name: "marketing_competitors",
    source: "local",
    description: "CRUD operations on the Competitors tracking sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("remove"),
      ], { description: "Operation to perform" }),
      competitor: Type.Optional(Type.String({ description: "Competitor name (required for add/update/remove)" })),
      data: Type.Optional(Type.Object({
        url: Type.Optional(Type.String({ description: "Competitor website URL" })),
        strengths: Type.Optional(Type.String({ description: "Competitor strengths" })),
        weaknesses: Type.Optional(Type.String({ description: "Competitor weaknesses" })),
        notes: Type.Optional(Type.String({ description: "Additional notes" })),
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Competitors",
        headers: ["Competitor", "URL", "Strengths", "Weaknesses", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Competitor",
        keyValue: params.competitor as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  const marketingContentCalendar: ToolEntry = {
    name: "marketing_content_calendar",
    source: "local",
    description: "CRUD operations on the Content Calendar sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("remove"),
      ], { description: "Operation to perform" }),
      entryId: Type.Optional(Type.String({ description: "Entry title (required for update/remove)" })),
      data: Type.Optional(Type.Object({
        title: Type.Optional(Type.String({ description: "Content title" })),
        type: Type.Optional(Type.String({ description: "Content type (blog, landing, email, social)" })),
        keyword: Type.Optional(Type.String({ description: "Target keyword" })),
        status: Type.Optional(Type.String({ description: "Status (idea, draft, review, published)" })),
        publishDate: Type.Optional(Type.String({ description: "Target publish date" })),
        assignee: Type.Optional(Type.String({ description: "Assigned to" })),
        notes: Type.Optional(Type.String({ description: "Additional notes" })),
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Content Calendar",
        headers: ["Title", "Type", "Keyword", "Status", "PublishDate", "Assignee", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Title",
        keyValue: params.entryId as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  return [seoAudit, marketingKeywords, marketingCompetitors, marketingContentCalendar];
```

**Step 2: Add the shared `sheetCrud` helper function above `createMarketingToolEntries`**

This helper handles all CRUD logic for any sheet tab, keeping the tool definitions DRY.

```ts
interface SheetCrudOpts {
  credentialStore?: CredentialStore;
  tab: string;
  headers: string[];
  action: string;
  keyField: string;
  keyValue?: string;
  data?: Record<string, string>;
}

async function sheetCrud(opts: SheetCrudOpts) {
  const { tab, headers, action, keyField, keyValue, data } = opts;

  try {
    const spreadsheetId = getSheetId();
    const auth = await getGoogleAuth({ credentialStore: opts.credentialStore });
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${tab}!A:${String.fromCharCode(64 + headers.length)}`;

    if (action === "list") {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const allValues = res.data.values ?? [];
      if (allValues.length <= 1) {
        return textResult(JSON.stringify({ tab, rows: [], rowCount: 0 }));
      }
      const hdr = allValues[0] as string[];
      const rows = allValues.slice(1).map((row) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < hdr.length; i++) obj[hdr[i]!] = row[i] ?? null;
        return obj;
      });
      return textResult(JSON.stringify({ tab, rowCount: rows.length, rows }, null, 2));
    }

    if (!keyValue) {
      return textResult(`Error: ${keyField} is required for ${action}`);
    }

    if (action === "add") {
      // Ensure headers exist
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:1` });
      if (!existing.data.values?.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab}!A1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [headers] },
        });
      }

      const row = headers.map((h) => {
        if (h === keyField) return keyValue;
        if (h === "Updated") return new Date().toISOString().slice(0, 10);
        const dataKey = h.charAt(0).toLowerCase() + h.slice(1);
        return data?.[dataKey] ?? data?.[h] ?? "";
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return textResult(`Added "${keyValue}" to ${tab}`);
    }

    // For update/remove, find the row
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const allValues = res.data.values ?? [];
    if (allValues.length <= 1) {
      return textResult(`Error: No data in ${tab}`);
    }
    const hdr = allValues[0] as string[];
    const keyCol = hdr.indexOf(keyField);
    if (keyCol === -1) {
      return textResult(`Error: Column "${keyField}" not found in ${tab}`);
    }
    const rowIndex = allValues.findIndex((row, i) => i > 0 && row[keyCol] === keyValue);
    if (rowIndex === -1) {
      return textResult(`Error: "${keyValue}" not found in ${tab}`);
    }

    if (action === "remove") {
      // Clear the row (Sheets API doesn't have a "delete row" via values — we clear and leave blank)
      const clearRange = `${tab}!A${rowIndex + 1}:${String.fromCharCode(64 + headers.length)}${rowIndex + 1}`;
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: clearRange });
      return textResult(`Removed "${keyValue}" from ${tab}`);
    }

    if (action === "update") {
      const existingRow = allValues[rowIndex]!;
      const updatedRow = hdr.map((h, i) => {
        if (h === "Updated") return new Date().toISOString().slice(0, 10);
        const dataKey = h.charAt(0).toLowerCase() + h.slice(1);
        const newVal = data?.[dataKey] ?? data?.[h];
        return newVal ?? existingRow[i] ?? "";
      });
      const updateRange = `${tab}!A${rowIndex + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: updateRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [updatedRow] },
      });
      return textResult(`Updated "${keyValue}" in ${tab}`);
    }

    return textResult(`Error: Unknown action "${action}"`);
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`);
  }
}
```

**Step 3: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/core/marketing-tools.ts
git commit -m "feat(marketing): add Sheets CRUD tools (keywords, competitors, content calendar)"
```

---

### Task 2: Add marketing agent definition to `agents.ts`

**Files:**
- Modify: `packages/core/agents.ts:1-3` (add import)
- Modify: `packages/core/agents.ts:40-61` (update orchestrator prompt)
- Modify: `packages/core/agents.ts:415-417` (add marketing agent + return)

**Step 1: Add the import at the top of `agents.ts`**

After line 15 (`import { createFrontendToolEntries } from "./frontend-tools";`), add:

```ts
import { createMarketingToolEntries } from "./marketing-tools";
```

**Step 2: Update the orchestrator system prompt**

In the orchestrator's `.systemPrompt()` array (lines 44–61), add after the web-designer line (line 54):

```ts
      "The marketing specialist handles SEO audits, keyword research, competitor analysis, and content calendar management via Google Sheets. It can delegate to writer/explorer/secretary.",
```

**Step 3: Add the marketing agent definition**

Before the `return` statement (line 417), add:

```ts
  const explorerToolsForMarketing = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const searchWebEntry = explorerToolsForMarketing.filter(t => t.name === "search_web");
  const browseUrlForMarketing = explorerToolsForMarketing.filter(t => t.name === "browse_url");
  const marketingToolEntries = createMarketingToolEntries({ credentialStore: opts?.credentialStore });

  const marketing = defineAgent("marketing")
    .name("Marketing")
    .role("SEO & growth strategist — keyword research, competitor analysis, on-page audits, content strategy via Google Sheets.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a virtual CMO focused on SEO and growth.",
      "",
      "Your tools:",
      "- seo_audit: Run an on-page SEO audit on any URL. Extracts title, meta, headings, images, links, schema, timing, and issues.",
      "- marketing_keywords: CRUD on Google Sheets 'Keywords' tab — track keyword volume, difficulty, position.",
      "- marketing_competitors: CRUD on Google Sheets 'Competitors' tab — track competitor URLs, strengths, weaknesses.",
      "- marketing_content_calendar: CRUD on Google Sheets 'Content Calendar' tab — manage content pipeline (idea → draft → review → published).",
      "- search_web: Search the web for keyword research, competitor discovery, and market trends.",
      "- browse_url: Fetch and read page content for competitor analysis and content research.",
      "",
      "Delegation:",
      "- Delegate to 'writer' for content creation (blog posts, landing pages, email copy).",
      "- Delegate to 'explorer' for complex multi-page research and deep browsing sessions.",
      "- Delegate to 'secretary' for scheduling campaigns, reminders, and calendar coordination.",
      "",
      "Guidelines:",
      "- Start with data: audit the current state before recommending changes.",
      "- Track everything in Sheets: keywords, competitors, content calendar — the user can inspect and edit directly.",
      "- Prioritize actionable recommendations over generic advice.",
      "- Be concise. Use structured output (tables, lists) over prose.",
    ].join("\n"))
    .capabilities([
      "seo-audit", "keyword-research", "competitor-analysis",
      "content-calendar", "web-search", "content-strategy",
    ])
    .localToolEntries([
      ...marketingToolEntries,
      ...searchWebEntry,
      ...browseUrlForMarketing,
    ])
    .permissions({
      seo_audit: "allow",
      marketing_keywords: "allow",
      marketing_competitors: "allow",
      marketing_content_calendar: "allow",
      search_web: "allow",
      browse_url: "allow",
    })
    .canDelegateTo(["writer", "explorer", "secretary"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();
```

**Step 4: Update the return array**

Change line 417 from:
```ts
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner];
```
to:
```ts
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner, marketing];
```

**Step 5: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/agents.ts
git commit -m "feat(marketing): register marketing agent with delegation to writer/explorer/secretary"
```

---

### Task 3: Add marketing to UI (`AGENT_PERSONALITIES`)

**Files:**
- Modify: `apps/web/types.ts:98-99`

**Step 1: Add the marketing entry**

After the `"web-designer"` line (line 98), add:

```ts
  marketing:      { accent: "#50fa7b", badge: "K", tagline: "growth is the game" },
```

Note: `explorer` uses `#50fa7b` too. Change marketing to a distinct green if desired — e.g., `"#69ff94"`.

**Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/types.ts
git commit -m "feat(marketing): add marketing personality to AGENT_PERSONALITIES"
```

---

### Task 4: Add smoke test

**Files:**
- Modify: `packages/core/runtime.ts:541` (update type + add marketing case)
- Modify: `apps/cli/index.ts:11` (add to VALID_SMOKES)
- Modify: `apps/cli/index.ts:259` (update usage string)
- Modify: `package.json:17` (add smoke:marketing script — already present, verify)

**Step 1: Update `runSmokeScenario` in `packages/core/runtime.ts`**

Change the type signature at line 541 from:
```ts
async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger") {
```
to:
```ts
async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger" | "web-designer" | "marketing") {
```

Before the final fallback `return this.chat({ toAgentId: ORCHESTRATOR_ID, ...` (around line 569), add:

```ts
        if (name === "web-designer") {
            return this.chat({
                toAgentId: "web-designer",
                content: "List the main accessibility best practices for a modern landing page. Return a concise bullet list.",
            });
        }
        if (name === "marketing") {
            return this.chat({
                toAgentId: "marketing",
                content: "Audit the SEO of https://example.com and list the top issues found.",
            });
        }
```

**Step 2: Update `VALID_SMOKES` in `apps/cli/index.ts`**

Change line 11 from:
```ts
const VALID_SMOKES = ["math", "code", "orchestrator", "explorer", "writer", "debugger"] as const;
```
to:
```ts
const VALID_SMOKES = ["math", "code", "orchestrator", "explorer", "writer", "debugger", "web-designer", "marketing"] as const;
```

**Step 3: Update the usage help string**

At line 259, update the usage message to include new agents:
```ts
console.log("Uso: /smoke math|code|orchestrator|explorer|writer|debugger|web-designer|marketing");
```

**Step 4: Verify `package.json` already has the smoke:marketing script**

`package.json` line 17 already has `"smoke:marketing": "bun run apps/cli/index.ts --smoke marketing"`. Verify it's there. If not, add it.

**Step 5: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/runtime.ts apps/cli/index.ts package.json
git commit -m "feat(marketing): add smoke:marketing test and update VALID_SMOKES"
```

---

### Task 5: Update documentation (CLAUDE.md, README.md, AGENTS.md)

**Files:**
- Modify: `CLAUDE.md` (model config section, agent builder context, Google Workspace section)
- Modify: `README.md` (agent list, commands)
- Modify: `AGENTS.md` (agent reference)

**Step 1: Update `CLAUDE.md`**

In the **Model Configuration** section, add after the `web-designer` line:

```
- `marketing` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url`; delegates to `writer`, `explorer`, `secretary`)
```

In the **Google Workspace Integration** → **Agent tool assignments** section, add:

```
- `marketing`: `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar` (Google Sheets via `MARKETING_SHEET_ID`)
```

In the **Operational Runbook** section, add:

```
- `bun run smoke:marketing`
```

Marketing prerequisite:
```
- Set `MARKETING_SHEET_ID` env var (or store in CredentialStore domain `"marketing"`) pointing to a Google Sheets spreadsheet with tabs: "Keywords", "Competitors", "Content Calendar"
```

**Step 2: Update `README.md`**

Add marketing to the agent list table and mention `smoke:marketing` in the commands section.

**Step 3: Update `AGENTS.md`**

Add a marketing agent section with its capabilities, tools, delegation targets, and configuration.

**Step 4: Verify no typos with a quick typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "docs: add marketing agent to CLAUDE.md, README.md, AGENTS.md"
```

---

### Task 6: Run full typecheck and smoke test

**Files:** None (verification only)

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — zero errors

**Step 2: Run existing tests**

Run: `bun test`
Expected: All existing tests pass

**Step 3: Run the marketing smoke test**

Run: `bun run smoke:marketing`
Expected: Returns an SEO audit result for example.com (or an error about Playwright not installed / no browser — acceptable in CI). The key validation is that the agent starts, the tool is invoked, and the response is structured.

**Step 4: Verify the agent shows in the UI**

Run: `bun run ui` and check that "marketing" appears in the sidebar with badge "K" and green accent.

**Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during marketing agent verification"
```
