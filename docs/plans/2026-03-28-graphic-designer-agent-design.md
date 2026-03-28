# Graphic Designer Agent Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a "graphic-designer" specialist agent — a virtual creative director — capable of generating images with Google Gemini ImageGen, creating and exporting designs in Canva, and reading/exporting assets from Figma.

**Architecture:** New `packages/core/graphic-designer-tools.ts` module with 6 local tools. Cherry-picks `search_web` + `browse_url` from explorer tools. Receives delegations from `orchestrator` and `marketing`. Delegates to `explorer` for visual references.

**Tech Stack:** Google Gemini AI REST API (image generation), Canva Connect API (design CRUD + export), Figma REST API (read + export). All credentials via CredentialStore.

---

## 1. Tools Architecture

### New module: `packages/core/graphic-designer-tools.ts`

Exports `createGraphicDesignerToolEntries(): ToolEntry[]` with 6 tools:

#### `generate_image`
- **Input:** `{ prompt: string, style?: string, aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" }`
- **Output:** `{ imageUrl: string, localPath?: string }`
- Calls Google Gemini AI REST API directly via `fetch` (no Playwright)
- Credential domain `"gemini"` → field `apiKey`
- Returns a publicly accessible image URL or saves locally if `localPath` requested

#### `canva_create`
- **Input:** `{ title: string, designType: "poster" | "social_media" | "banner" | "presentation", templateId?: string }`
- **Output:** `{ designId: string, editUrl: string }`
- Creates a new design via Canva Connect API
- Credential domain `"canva"` → field `apiKey`

#### `canva_get`
- **Input:** `{ designId: string }`
- **Output:** `{ title, thumbnail, editUrl, shareUrl }`
- Fetches design metadata from Canva Connect API

#### `canva_export`
- **Input:** `{ designId: string, format: "pdf" | "png" | "jpg" }`
- **Output:** `{ exportUrl: string, format: string }`
- Creates an export job and polls until complete (60s timeout, 2s interval)
- Returns `exportJobId` in error if timeout so caller can retry

#### `figma_get`
- **Input:** `{ fileKey: string, nodeId?: string }`
- **Output:** `{ name: string, frames: { id, name }[], components: { id, name }[] }`
- Read-only. Fetches file structure from Figma REST API v1
- Credential domain `"figma"` → field `accessToken`

#### `figma_export`
- **Input:** `{ fileKey: string, nodeIds: string[], format: "png" | "svg" | "pdf", scale?: number }`
- **Output:** `{ images: Record<nodeId, url> }`
- Exports node renders from Figma REST API (GET /v1/images/{key})

### Cherry-picked from explorer-tools.ts
- `search_web` — DuckDuckGo search for visual references, inspiration
- `browse_url` — page content extraction for reference imagery and competitor designs

> **Figma API limitation:** The Figma REST API is primarily read + export. Creating or editing Figma content programmatically requires a Figma Plugin (JavaScript running inside the Figma client). If create-in-Figma is needed in the future, it would require a separate Figma Plugin implementation beyond this scope.

## 2. Delegation

```ts
defineAgent("graphic-designer")
  .canDelegateTo(["explorer"], { maxDepth: 2 })
```

- **Receives from:** `orchestrator`, `marketing`
- **Delegates to:** `explorer` — for deep visual research, multi-page browsing of references, image hunting
- **Timeout:** 300s (same as `web-designer` and `marketing` — visual tasks can be slow)
- **Queuing:** if `explorer` is busy, requests queue via ChatManager FIFO (same pattern as marketing agent)

### Agent definition updates required
- Add `"graphic-designer"` to orchestrator's `.canDelegateTo()` targets
- Add `"graphic-designer"` to marketing agent's `.canDelegateTo()` targets
- Update orchestrator system prompt to describe the new agent

## 3. Agent Definition

```ts
defineAgent("graphic-designer")
  .name("Graphic Designer")
  .role("Visual creative: image generation, Canva design, Figma asset export")
  .model("openrouter", "google/gemini-3-flash-preview")
  .capabilities([
    "Generate images with Google Gemini ImageGen",
    "Create and export Canva designs (poster, social media, banner, presentation)",
    "Read and export assets from Figma files",
    "Search web for visual references and inspiration",
    "Delegate deep visual research to explorer",
  ])
  .systemPrompt(`You are a graphic designer agent — a virtual creative director.
You create visual content: generate images with AI, build designs in Canva, and extract assets from Figma.

When asked to create a piece:
1. Clarify the format and dimensions if not specified
2. Choose the right tool: Gemini for pure AI image generation, Canva for designed pieces (posters, banners, social posts), Figma for design system assets
3. Use search_web or browse_url (or delegate to explorer) to gather visual references first when helpful
4. Always return a usable URL or link to the created asset

Be concise. Return the output link/URL in your final answer.`)
  .tools([
    "generate_image", "canva_create", "canva_get", "canva_export",
    "figma_get", "figma_export", "search_web", "browse_url",
  ])
  .permissions({
    generate_image: "allow",
    canva_create: "allow",
    canva_get: "allow",
    canva_export: "allow",
    figma_get: "allow",
    figma_export: "allow",
    search_web: "allow",
    browse_url: "allow",
  })
  .canDelegateTo(["explorer"], { maxDepth: 2 })
  .maxConcurrency(1)
  .build()
```

### Orchestrator prompt addition
```
- graphic-designer — Visual creative: generates images with Gemini ImageGen, creates Canva designs (poster, social_media, banner, presentation), exports Figma assets. Delegates deep research to explorer. Use for any visual content creation task.
```

## 4. UI Identity

```ts
"graphic-designer": {
  accent: "#ff79c6",   // pink — creative/visual
  badge: "G",
  tagline: "pixels with purpose",
}
```

## 5. Error Handling & Configuration

### Missing credentials
- `"gemini"` not configured → `"Gemini API key not configured — store in CredentialStore domain 'gemini' with field 'apiKey'"`
- `"canva"` not configured → same pattern for Canva
- `"figma"` not configured → same pattern for Figma
- Each tool fails independently — if only Figma is missing, Gemini and Canva still work

### `canva_export` polling
- Timeout: 60s total, 2s polling interval
- On timeout: returns error including `exportJobId` so caller can retry

### Permissions
- All 6 tools: `"allow"` — no HITL on graphic designer's own tools
- Delegations to `explorer` inherit explorer's own permissions

## 6. Testing

- **Smoke test:** `smoke:graphic-designer` — prompt `"Generate an image of a sunset over mountains"`, verify `generate_image` returns valid structure with `imageUrl`
- **package.json:** `"smoke:graphic-designer": "bun run apps/cli/index.ts --smoke graphic-designer"`
- **Typecheck:** `graphic-designer-tools.ts` must pass `bun run typecheck`
- No unit tests in this iteration — all 3 APIs require real credentials; smoke test covers e2e with the most self-contained tool (`generate_image`)

## 7. Files to Create/Modify

| Action | File |
|--------|------|
| Create | `packages/core/graphic-designer-tools.ts` |
| Modify | `packages/core/agents.ts` (add graphic-designer + update orchestrator + marketing delegation) |
| Modify | `apps/web/types.ts` (add AGENT_PERSONALITIES entry) |
| Modify | `apps/cli/index.ts` (add smoke:graphic-designer case) |
| Modify | `package.json` (add smoke:graphic-designer script) |
| Modify | `CLAUDE.md` (add graphic-designer agent docs) |
| Modify | `README.md` (add graphic-designer agent docs) |
| Modify | `AGENTS.md` (add graphic-designer agent docs) |
