# Web Designer Agent — Design Spec

**Date**: 2026-03-26
**Status**: Approved

## Summary

Add a `web-designer` agent to the multi-agent runtime as a full frontend development specialist. Simultaneously upgrade the `code` agent with shared development tools (filesystem + execution). Both agents can delegate to each other bidirectionally.

## Goals

1. Dedicated frontend agent: HTML, CSS, React/TSX, Tailwind, design systems, responsive design, accessibility.
2. Shared development tools (`dev-tools.ts`) for both `code` and `web-designer`.
3. Frontend-specific tools: browser preview, responsive checks, a11y validation.
4. MCP integrations: Figma, icons, framework docs, design tokens (optional, progressive).
5. Bidirectional delegation between `web-designer` and `code`.

## Non-Goals

- Replacing the `explorer` agent's browsing capabilities.
- Building a visual design tool (Figma competitor).
- Image generation or AI-based design.

---

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `packages/core/dev-tools.ts` | Shared development tools: `read_file`, `write_file`, `edit_file`, `search_code`, `list_directory`, `run_command` |
| `packages/core/frontend-tools.ts` | Frontend-specific tools: `preview_page`, `check_responsive`, `validate_accessibility` |

### Modified Files

| File | Change |
|------|--------|
| `packages/core/agents.ts` | Add `web-designer` agent definition; update `code` agent with dev tools and delegation |
| `packages/core/browser.ts` | Expose screenshot/viewport utilities for frontend tools to reuse |
| `apps/web/types.ts` | Add `web-designer` to `AGENT_PERSONALITIES` |
| `CLAUDE.md` | Document new agent, tools, MCPs |
| `README.md` | Document new agent |
| `AGENTS.md` | Document new agent |

---

## Section 1: Shared Development Tools (`dev-tools.ts`)

New module `packages/core/dev-tools.ts` exporting `createDevToolEntries(options)`.

```ts
interface DevToolOptions {
  maxFileSize?: number;       // default 512KB
  maxSearchResults?: number;  // default 50
  basePath?: string;          // path traversal guard
  commandWhitelist?: string[]; // allowed command prefixes for run_command
}
```

### Tools

#### `read_file`
- **Migrated from**: `debugger-tools.ts` (same logic, same parameter names)
- **Default permission**: `hitl`
- **Parameters**: `{ filePath: string, startLine?: number, endLine?: number }`
- **Returns**: File content with line numbers
- **Note**: Parameter names match existing `debugger-tools.ts` exactly (`filePath`, `startLine`, `endLine`)

#### `search_code`
- **Migrated from**: `debugger-tools.ts` (same logic, same parameter names)
- **Default permission**: `hitl`
- **Parameters**: `{ pattern: string, directory: string, fileExtensions?: string[] }`
- **Returns**: Matching lines with file paths and line numbers
- **Note**: Parameter names match existing `debugger-tools.ts` exactly (`pattern`, `directory`, `fileExtensions`)

#### `list_directory`
- **Migrated from**: `debugger-tools.ts` (same logic, same parameter names)
- **Default permission**: `allow`
- **Parameters**: `{ directory: string, recursive?: boolean }`
- **Returns**: File/directory listing
- **Note**: Parameter names match existing `debugger-tools.ts` exactly (`directory`, `recursive`)

#### `write_file` (new)
- **Default permission**: `hitl`
- **Parameters**: `{ filePath: string, content: string, createDirs?: boolean }`
- **Behavior**: Creates or overwrites a file. If `createDirs` is true, creates parent directories. Validates path against `basePath` (no directory traversal).
- **Returns**: Confirmation with bytes written

#### `edit_file` (new)
- **Default permission**: `hitl`
- **Parameters**: `{ filePath: string, oldText: string, newText: string, replaceAll?: boolean }`
- **Behavior**: Reads the file, finds `oldText`, replaces with `newText`. Default: single-occurrence replacement — fails if `oldText` appears more than once (ambiguous). Set `replaceAll: true` to replace all occurrences. Fails if `oldText` is not found at all.
- **Returns**: Confirmation with diff summary (lines changed, before/after snippet)

#### `run_command` (new)
- **Default permission**: `hitl`
- **Parameters**: `{ command: string, cwd?: string, timeout?: number }`
- **Behavior**: Executes a shell command. Validates against an agent-specific whitelist passed via `DevToolOptions.commandWhitelist`. Default timeout 30s (configurable up to 120s).
- **Returns**: `{ stdout, stderr, exitCode, durationMs }`
- **Whitelist per agent** (passed via `createDevToolEntries({ commandWhitelist })`):
  - `web-designer`: `["bun build", "bun test", "bunx tailwindcss", "bunx eslint", "bunx prettier", "bun run"]`
  - `code`: `["bun build", "bun test", "bun run", "bunx tsc"]`
- **Whitelist matching**: The command string is split by whitespace. The first N tokens are matched as a prefix against each whitelist entry. For example, `bun run dev` matches `bun run`.
- **Security**:
  - Commands not matching the whitelist prefix are rejected with an error.
  - Shell metacharacters (`;`, `&&`, `||`, `|`, `` ` ``, `$()`) are rejected outright before whitelist check.
  - No arbitrary shell execution.

### Migration Note

The three read-only tools (`read_file`, `search_code`, `list_directory`) are copied from `debugger-tools.ts` with identical parameter schemas and logic. The `debugger` agent continues using its existing tools from `debugger-tools.ts` — no breakage. Future consolidation (shared utility functions) is possible but out of scope.

---

## Section 2: Frontend-Specific Tools (`frontend-tools.ts`)

New module `packages/core/frontend-tools.ts` exporting `createFrontendToolEntries()`.

All tools reuse the Playwright browser infrastructure from `packages/core/browser.ts`.

### Tools

#### `preview_page`
- **Default permission**: `allow`
- **Parameters**: `{ url: string, viewport?: { width: number, height: number } }`
- **Behavior**: Navigates to a URL (typically localhost dev server), waits for load, extracts rendered HTML and page metadata.
- **Returns**: `{ html: string (readable text, truncated to 8KB), title: string, url: string, viewport: { width, height }, screenshotPath: string }`
- **Default viewport**: 1280x720
- **Screenshots**: Saved to `.runtime-data/screenshots/<timestamp>.png` as artifacts for the human user. The LLM receives the text-based HTML extraction (same approach as `browseUrl` in `browser.ts`). The screenshot file path is returned so the user can inspect it.

#### `check_responsive`
- **Default permission**: `allow`
- **Parameters**: `{ url: string, viewports?: Array<{ name: string, width: number, height: number }> }`
- **Behavior**: Loads page at multiple viewports. Defaults: mobile (375x667), tablet (768x1024), desktop (1440x900). Extracts visible text and layout metrics (scroll height, element count) at each viewport.
- **Returns**: `{ results: Array<{ name, viewport, html (truncated), metrics: { scrollHeight, elementCount }, screenshotPath }> }`
- **Screenshots**: Saved per viewport to `.runtime-data/screenshots/`. The LLM receives text content + layout metrics to detect responsive issues (content overflow, missing elements). Screenshots are for human review.

#### `validate_accessibility`
- **Default permission**: `allow`
- **Parameters**: `{ url: string, standard?: "wcag2a" | "wcag2aa" }`
- **Behavior**: Loads page, injects axe-core via `page.evaluate()`, runs accessibility audit.
- **Returns**: `{ violations: Array<{ id, impact, description, nodes: number }>, passes: number, total: number }`
- **Default standard**: `wcag2aa`

### Dependencies

- `axe-core` — loaded from `node_modules/axe-core/axe.min.js` via `Bun.file()` at runtime, injected into Playwright page context via `page.addScriptTag()`
- Browser pool from `browser.ts` — same launch timeouts, cooldown, shared instance

### Shared `browse_url`

The `web-designer` receives `browse_url` from `explorer-tools.ts`. Implementation: filter the array returned by `createExplorerToolEntries()`:

```ts
const explorerTools = createExplorerToolEntries();
const browseUrlEntry = explorerTools.filter(t => t.name === "browse_url");
```

This lets the agent inspect external sites for reference/inspiration. It does NOT get `search_web` or `interact_page`.

---

## Section 3: Agent Definitions

### New Agent: `web-designer`

```ts
const explorerTools = createExplorerToolEntries();
const browseUrlEntry = explorerTools.filter(t => t.name === "browse_url");

const webDesigner = defineAgent("web-designer")
  .name("Web Designer & Frontend Dev")
  .role("Designs and builds frontend interfaces — HTML, CSS, React/TSX, Tailwind. "
    + "Reads/writes project files, previews in browser, validates accessibility. "
    + "Knows React, Next.js, Astro, shadcn, design systems.")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt("You are a frontend specialist. You build UI components, pages, "
    + "and layouts. You write clean, accessible, responsive code. You read existing "
    + "code to understand patterns before making changes. You preview your work in "
    + "the browser and validate accessibility. When you need backend endpoints, "
    + "delegate to the code specialist.")
  .capabilities([
    "html", "css", "tailwind", "react", "tsx",
    "responsive-design", "accessibility", "design-systems",
    "component-architecture", "preview", "prototyping",
    "nextjs", "astro", "shadcn",
  ])
  .localToolEntries([
    ...createDevToolEntries({
      commandWhitelist: ["bun build", "bun test", "bunx tailwindcss",
        "bunx eslint", "bunx prettier", "bun run"],
    }),
    ...createFrontendToolEntries(),
    ...browseUrlEntry,
  ])
  .permissions({
    "read_file": "hitl",
    "write_file": "hitl",
    "edit_file": "hitl",
    "run_command": "hitl",
    "search_code": "hitl",
  })
  .canDelegateTo(["code"], { maxDepth: 2 })
  .maxConcurrency(1)
  .build();
```

### Updated Agent: `code`

```ts
const code = defineAgent("code")
  .name("Code Specialist")
  .role("Creates, edits, and debugs backend code.")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt("You are a coding specialist. Return concise, practical answers. "
    + "You can read, write, and edit files in the project. You can run build and "
    + "test commands. When you need frontend work, delegate to the web-designer.")
  .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
  .localToolEntries([
    ...createDevToolEntries({
      commandWhitelist: ["bun build", "bun test", "bun run", "bunx tsc"],
    }),
  ])
  .permissions({
    "read_file": "hitl",
    "write_file": "hitl",
    "edit_file": "hitl",
    "run_command": "hitl",
    "search_code": "hitl",
  })
  .canDelegateTo(["web-designer"], { maxDepth: 2 })
  .maxConcurrency(1)
  .build();
```

### Delegation Depth Semantics

The `maxDepth` value in `.canDelegateTo()` is checked against the cumulative `RunContext.delegationDepth` (incremented by +1 at each hop in `delegation.ts`). This means `maxDepth: 2` limits to 2 total hops from wherever the chain started — it is NOT per-agent.

Example valid chain: `orchestrator → web-designer (depth 1) → code (depth 2) → done`.
Example blocked chain: `orchestrator → web-designer (depth 1) → code (depth 2) → web-designer (depth 3, blocked)`.

The existing cycle detection in `delegation.ts` (checks `delegationChain` for repeated agent IDs) provides an additional safety net.

### Return Array Update

Add `webDesigner` to the return array in `createAgentDefinitions()`:

```ts
return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner];
```

---

## Section 4: MCP Integrations

MCPs are **optional** — the agent works fully with local tools only. MCPs activate when configured via `RuntimeOptions.mcpServers`.

### Planned MCP Servers

#### Figma (`mcp:figma/*`)
- **Transport**: `http`
- **Tools**: `figma_get_file`, `figma_get_styles`, `figma_get_components`, `figma_extract_tokens`
- **Permissions**: read tools `allow`, `figma_extract_tokens` → `hitl`
- **Requires**: `FIGMA_ACCESS_TOKEN` env var

#### Icons (`mcp:icons/*`)
- **Transport**: `stdio`
- **Tools**: `icons_search`, `icons_get_svg`
- **Permissions**: all `allow`
- **Behavior**: Searches Lucide, Heroicons, Phosphor. Returns SVG markup.

#### Framework Docs (`mcp:docs/*`)
- **Transport**: `stdio`
- **Tools**: `docs_search`, `docs_read_page`
- **Permissions**: all `allow`
- **Behavior**: Indexed documentation for React, Tailwind, Next.js, Astro, shadcn.

#### Design Tokens (`mcp:tokens/*`)
- **Transport**: `stdio`
- **Tools**: `tokens_read`, `tokens_write`, `tokens_transform`
- **Permissions**: `tokens_read` and `tokens_transform` → `allow`, `tokens_write` → `hitl`
- **Behavior**: Reads/writes design tokens in JSON or CSS custom properties format.

### Agent MCP Configuration

```ts
defineAgent("web-designer")
  .mcpTools(["mcp:figma/*", "mcp:icons/*", "mcp:docs/*", "mcp:tokens/*"])
```

Glob patterns resolve all tools from each connected MCP server. If a server is not connected, its tools simply don't appear.

---

## Section 5: Orchestrator & UI Updates

### Orchestrator

- Add `"web-designer"` to orchestrator's delegation targets in `agents.ts`
- Add description line to orchestrator system prompt (same format as existing agents):
  `"The web-designer specialist builds frontend interfaces (HTML, CSS, React, Tailwind), previews pages, and validates accessibility."`
- Routing heuristics: keywords like "UI", "frontend", "component", "page", "layout", "styles", "CSS", "responsive", "design" → `web-designer`. Keywords like "API", "endpoint", "backend", "server", "database" → `code`.

### Web UI (Dithie Dashboard)

- Add `web-designer` entry to `AGENT_PERSONALITIES` in `apps/web/types.ts`
- Agent appears in sidebar with dedicated view (activity, chat, delegation history)
- Shows bidirectional delegations between `web-designer` and `code`

### Documentation

Update in the same change:
- `CLAUDE.md`: new agent, tools, MCPs, capabilities, model config
- `README.md`: agent list, tool list, MCP section
- `AGENTS.md`: agent description and responsibilities

---

## Section 6: Error Handling

Follows existing patterns:

- `errorMessage(err)` from `packages/core/errors.ts` for unknown errors
- `safeAsync(fn, label)` for fire-and-forget operations
- `run_command` captures stdout + stderr, returns both with exit code
- `run_command` timeout default 30s, max 120s
- `write_file` / `edit_file` validate paths (no traversal outside project root)
- Frontend tools inherit browser error handling (launch timeout, navigation timeout, cooldown)
- All tool `execute` functions wrapped in try-catch returning `textResult("Error: ...")` on failure

---

## Testing Strategy

### Unit tests
- `dev-tools.test.ts`: write_file creates files, edit_file replaces text, run_command respects whitelist
- `frontend-tools.test.ts`: preview_page returns screenshot + HTML, check_responsive handles multiple viewports, validate_accessibility returns violations

### Smoke tests

- `bun run smoke:web-designer` — add to `package.json` scripts. Delegates a task like "create a simple HTML page with a heading and a button" to the `web-designer` agent, verifies it uses `write_file` and returns a result.
- Update `bun run smoke:code` — verify code agent now has dev tools (can use `read_file`, `write_file`).

### Integration
- Bidirectional delegation: orchestrator → web-designer → code → result
- MCP connection/disconnection (when configured)
