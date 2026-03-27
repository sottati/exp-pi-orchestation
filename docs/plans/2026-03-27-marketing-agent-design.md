# Marketing Agent Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a "marketing" specialist agent — a virtual CMO focused on SEO & growth — with keyword research, competitor analysis, on-page SEO audits, content strategy, and Google Sheets as its data backend.

**Architecture:** New `packages/core/marketing-tools.ts` module with 4 local tools (`seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`). Cherry-picks `search_web` + `browse_url` from explorer tools. Direct delegation to `writer`, `explorer`, and `secretary` agents with `maxDepth: 2`.

**Tech Stack:** Playwright (via Node bridge) for SEO audits, Google Sheets API (googleapis) for persistent state, existing browser utilities from `packages/core/browser.ts`.

---

## 1. Tools Architecture

### New module: `packages/core/marketing-tools.ts`

Exports `createMarketingToolEntries(): ToolEntry[]` with 4 tools:

#### `seo_audit`
- **Input:** `{ url: string }`
- **Output:** `{ title, metaDescription, metaKeywords, h1, headings: {h2,h3}[], altTexts[], internalLinks, externalLinks, schemaMarkup, loadTimeMs, issues[] }`
- Uses `safeLaunchAndRun` from `browser.ts` (Playwright via Node bridge)
- Extracts on-page SEO signals: title, meta tags, heading hierarchy, image alt texts, link analysis, structured data, page timing
- Timeout: 30s launch, 15s operation (same as explorer)

#### `marketing_keywords`
- **Input:** `{ action: "list" | "add" | "update" | "remove", keyword?, data?: { volume?, difficulty?, position?, notes? } }`
- **Output:** rows from "Keywords" sheet tab
- CRUD operations on Google Sheets "Keywords" tab
- Requires `MARKETING_SHEET_ID` env var or CredentialStore domain `"marketing"`

#### `marketing_competitors`
- **Input:** `{ action: "list" | "add" | "update" | "remove", competitor?, data?: { url?, strengths?, weaknesses?, notes? } }`
- **Output:** rows from "Competitors" sheet tab
- CRUD operations on Google Sheets "Competitors" tab

#### `marketing_content_calendar`
- **Input:** `{ action: "list" | "add" | "update" | "remove", entryId?, data?: { title?, type?, keyword?, status?, publishDate?, assignee?, notes? } }`
- **Output:** rows from "Content Calendar" sheet tab
- CRUD operations on Google Sheets "Content Calendar" tab

### Cherry-picked from explorer-tools.ts
- `search_web` — DuckDuckGo search for keyword research and competitor discovery
- `browse_url` — page content extraction for competitor analysis

## 2. Delegation

```ts
.canDelegateTo(["writer", "explorer", "secretary"], { maxDepth: 2 })
```

- **writer**: content creation (blog posts, landing pages, email copy)
- **explorer**: complex multi-page browsing, deep research
- **secretary**: scheduling campaigns, reminders, calendar coordination

Direct delegation (not via orchestrator). Queued via ChatManager FIFO if target agent is busy.

## 3. Agent Definition

```ts
defineAgent("marketing")
  .name("Marketing")
  .role("SEO & growth strategist — keyword research, competitor analysis, on-page audits, content strategy")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .capabilities([
    "SEO audit & on-page analysis",
    "Keyword research & tracking",
    "Competitor analysis",
    "Content calendar management",
    "Web search for market research",
    "Delegate content creation to writer",
    "Delegate deep research to explorer",
    "Delegate scheduling to secretary",
  ])
  .systemPrompt(`You are a virtual CMO focused on SEO and growth...`)
  .tools([
    "seo_audit", "marketing_keywords", "marketing_competitors", "marketing_content_calendar",
    "search_web", "browse_url"
  ])
  .localToolEntries(marketingToolEntries)
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
  .build()
```

### Orchestrator update
Add `"marketing"` to orchestrator's delegation targets.

### Orchestrator prompt addition
```
- marketing — SEO & growth strategist: keyword research, competitor analysis, on-page SEO audits, content calendar, Google Sheets tracking. Can delegate to writer/explorer/secretary.
```

## 4. UI Identity

```ts
"marketing": {
  accent: "#50fa7b",
  badge: "K",
  tagline: "growth is the game",
}
```

## 5. Error Handling & Configuration

- **Google Sheets**: if `MARKETING_SHEET_ID` not configured, the 3 CRUD tools return: `"MARKETING_SHEET_ID not configured — set env var or store in CredentialStore domain 'marketing'"`
- **SEO Audit**: uses `safeLaunchAndRun` with 30s launch / 15s operation timeouts. Playwright runs bridged to Node (not direct Bun). On failure, returns error with hint: `bunx playwright install chromium` + verify `node` in PATH
- **Delegations**: if target agent unavailable, request is queued in ChatManager (FIFO + maxConcurrency) — never discarded
- **Permissions**: all tools `"allow"`. No HITL on marketing's own tools (delegations inherit target agent's permissions)

## 6. Testing

- **Smoke test**: `smoke:marketing` — prompt "Audit the SEO of example.com", verify `seo_audit` returns valid structure
- **package.json**: `"smoke:marketing": "bun run apps/cli/index.ts --smoke marketing"`
- **Typecheck**: `marketing-tools.ts` must pass `bun run typecheck`
- No unit tests in this iteration — Sheets tools need real credentials, smoke test covers e2e flow

## 7. Files to Create/Modify

| Action | File |
|--------|------|
| Create | `packages/core/marketing-tools.ts` |
| Modify | `packages/core/agents.ts` (add marketing agent + orchestrator delegation) |
| Modify | `apps/web/types.ts` (add AGENT_PERSONALITIES entry) |
| Modify | `apps/cli/index.ts` (add smoke:marketing case) |
| Modify | `package.json` (add smoke:marketing script) |
| Modify | `CLAUDE.md` (add marketing agent docs) |
| Modify | `README.md` (add marketing agent docs) |
| Modify | `AGENTS.md` (add marketing agent docs) |
