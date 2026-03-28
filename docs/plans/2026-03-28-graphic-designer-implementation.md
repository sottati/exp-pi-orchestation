# Graphic Designer Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `graphic-designer` specialist agent with Gemini ImageGen, Canva Connect API, and Figma REST API tools.

**Architecture:** New `packages/core/graphic-designer-tools.ts` exports `createGraphicDesignerToolEntries()` with 6 local tools. Agent definition added to `packages/core/agents.ts` following the same pattern as `marketing`. Cherry-picks `search_web` + `browse_url` from explorer tools. UI personality added to `apps/web/types.ts`. Smoke test wired in `runtime.ts` and `cli/index.ts`.

**Tech Stack:** Bun fetch (no extra deps), Google Generative Language API (Imagen 3), Canva Connect API v1, Figma REST API v1. All credentials via `CredentialStore` with env var fallback.

> **Color note:** The design doc proposed `#ff79c6` for accent, but that color is already used by `writer`. This plan uses `#ffd700` (gold) instead.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `packages/core/graphic-designer-tools.ts` | 6 local tool entries: generate_image, canva_create, canva_get, canva_export, figma_get, figma_export |
| Modify | `packages/core/agents.ts` | Import + instantiate graphic-designer; update orchestrator prompt; add graphic-designer to marketing delegation; add to return array |
| Modify | `apps/web/types.ts` | Add `"graphic-designer"` entry to `AGENT_PERSONALITIES` |
| Modify | `packages/core/runtime.ts` | Extend `runSmokeScenario` type union + add `graphic-designer` case |
| Modify | `apps/cli/index.ts` | Add `"graphic-designer"` to `VALID_SMOKES` + help text |
| Modify | `package.json` | Add `smoke:graphic-designer` script |
| Modify | `CLAUDE.md` | Document graphic-designer agent |
| Modify | `README.md` | Document graphic-designer agent |
| Modify | `AGENTS.md` | Document graphic-designer agent |

---

## Task 1: Create `packages/core/graphic-designer-tools.ts`

**Files:**
- Create: `packages/core/graphic-designer-tools.ts`

- [ ] **Step 1: Create the file**

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { errorMessage } from "./errors";

export interface GraphicDesignerToolOptions {
  credentialStore?: CredentialStore;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

async function getGeminiApiKey(credentialStore?: CredentialStore): Promise<string> {
  if (credentialStore) {
    const cred = await credentialStore.get("gemini");
    const key = (cred as Record<string, unknown> | null)?.["apiKey"];
    if (typeof key === "string" && key) return key;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "Gemini API key not configured — store in CredentialStore domain 'gemini' with field 'apiKey'",
    );
  }
  return key;
}

async function getCanvaApiKey(credentialStore?: CredentialStore): Promise<string> {
  if (credentialStore) {
    const cred = await credentialStore.get("canva");
    const key = (cred as Record<string, unknown> | null)?.["apiKey"];
    if (typeof key === "string" && key) return key;
  }
  const key = process.env.CANVA_API_KEY;
  if (!key) {
    throw new Error(
      "Canva API key not configured — store in CredentialStore domain 'canva' with field 'apiKey'",
    );
  }
  return key;
}

async function getFigmaAccessToken(credentialStore?: CredentialStore): Promise<string> {
  if (credentialStore) {
    const cred = await credentialStore.get("figma");
    const token = (cred as Record<string, unknown> | null)?.["accessToken"];
    if (typeof token === "string" && token) return token;
  }
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Figma access token not configured — store in CredentialStore domain 'figma' with field 'accessToken'",
    );
  }
  return token;
}

export function createGraphicDesignerToolEntries(opts?: GraphicDesignerToolOptions): ToolEntry[] {
  const credentialStore = opts?.credentialStore;

  const generateImage: ToolEntry = {
    name: "generate_image",
    source: "local",
    description:
      "Generate an image using Google Gemini ImageGen (Imagen 3). Returns image data URI and metadata.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Description of the image to generate" }),
      style: Type.Optional(
        Type.String({
          description:
            "Optional style hint (e.g. 'photorealistic', 'watercolor', 'flat illustration')",
        }),
      ),
      aspectRatio: Type.Optional(
        Type.Union(
          [
            Type.Literal("1:1"),
            Type.Literal("16:9"),
            Type.Literal("9:16"),
            Type.Literal("4:3"),
          ],
          { description: "Aspect ratio of the generated image (default: 1:1)" },
        ),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const apiKey = await getGeminiApiKey(credentialStore);
        const prompt = params.prompt as string;
        const style = params.style as string | undefined;
        const aspectRatio = (params.aspectRatio as string | undefined) ?? "1:1";
        const fullPrompt = style ? `${prompt}. Style: ${style}` : prompt;

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instances: [{ prompt: fullPrompt }],
              parameters: { sampleCount: 1, aspectRatio },
            }),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          return textResult(`Error from Gemini ImageGen API (${response.status}): ${body}`);
        }

        const data = (await response.json()) as {
          predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
        };

        const prediction = data.predictions?.[0];
        if (!prediction?.bytesBase64Encoded) {
          return textResult("Error: Gemini ImageGen returned no image data");
        }

        const mimeType = prediction.mimeType ?? "image/png";
        const dataUri = `data:${mimeType};base64,${prediction.bytesBase64Encoded}`;

        return textResult(
          [
            `Image generated successfully.`,
            `Aspect ratio: ${aspectRatio}`,
            `Prompt: ${fullPrompt}`,
            `MIME type: ${mimeType}`,
            `Data URI available (${prediction.bytesBase64Encoded.length} base64 chars).`,
          ].join("\n"),
          { dataUri, mimeType, prompt: fullPrompt, aspectRatio },
        );
      } catch (err) {
        return textResult(`Error generating image: ${errorMessage(err)}`);
      }
    },
  };

  const canvaCreate: ToolEntry = {
    name: "canva_create",
    source: "local",
    description: "Create a new Canva design. Returns the design ID and edit URL.",
    parameters: Type.Object({
      title: Type.String({ description: "Title for the design" }),
      designType: Type.Union(
        [
          Type.Literal("poster"),
          Type.Literal("social_media"),
          Type.Literal("banner"),
          Type.Literal("presentation"),
        ],
        { description: "Type of design to create" },
      ),
      templateId: Type.Optional(
        Type.String({ description: "Optional Canva template ID to base the design on" }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const apiKey = await getCanvaApiKey(credentialStore);
        const title = params.title as string;
        const designType = params.designType as string;
        const templateId = params.templateId as string | undefined;

        const body: Record<string, unknown> = {
          title,
          design_type: { type: designType },
        };
        if (templateId) body.asset_id = templateId;

        const response = await fetch("https://api.canva.com/rest/v1/designs", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errBody = await response.text();
          return textResult(`Canva API error (${response.status}): ${errBody}`);
        }

        const data = (await response.json()) as {
          design?: { id?: string; urls?: { edit_url?: string } };
        };

        const designId = data.design?.id;
        const editUrl = data.design?.urls?.edit_url;
        if (!designId) return textResult("Error: Canva did not return a design ID");

        return textResult(
          [`Design created.`, `ID: ${designId}`, `Edit URL: ${editUrl ?? "(not available)"}`].join(
            "\n",
          ),
          { designId, editUrl, title, designType },
        );
      } catch (err) {
        return textResult(`Error creating Canva design: ${errorMessage(err)}`);
      }
    },
  };

  const canvaGet: ToolEntry = {
    name: "canva_get",
    source: "local",
    description: "Get details of an existing Canva design by ID.",
    parameters: Type.Object({
      designId: Type.String({ description: "The Canva design ID" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const apiKey = await getCanvaApiKey(credentialStore);
        const designId = params.designId as string;

        const response = await fetch(`https://api.canva.com/rest/v1/designs/${designId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!response.ok) {
          const errBody = await response.text();
          return textResult(`Canva API error (${response.status}): ${errBody}`);
        }

        const data = (await response.json()) as {
          design?: {
            id?: string;
            title?: string;
            urls?: { edit_url?: string; view_url?: string };
            thumbnail?: { url?: string };
          };
        };

        const d = data.design;
        if (!d) return textResult("Error: Canva returned no design data");

        return textResult(
          [
            `Design: ${d.title ?? "(untitled)"}`,
            `ID: ${d.id}`,
            `Edit URL: ${d.urls?.edit_url ?? "(none)"}`,
            `View URL: ${d.urls?.view_url ?? "(none)"}`,
            `Thumbnail: ${d.thumbnail?.url ?? "(none)"}`,
          ].join("\n"),
          {
            designId: d.id,
            title: d.title,
            editUrl: d.urls?.edit_url,
            viewUrl: d.urls?.view_url,
            thumbnail: d.thumbnail?.url,
          },
        );
      } catch (err) {
        return textResult(`Error fetching Canva design: ${errorMessage(err)}`);
      }
    },
  };

  const canvaExport: ToolEntry = {
    name: "canva_export",
    source: "local",
    description:
      "Export a Canva design to PDF, PNG, or JPG. Polls until the export job completes (60s timeout). Returns exportJobId on timeout so you can retry.",
    parameters: Type.Object({
      designId: Type.String({ description: "The Canva design ID to export" }),
      format: Type.Union([Type.Literal("pdf"), Type.Literal("png"), Type.Literal("jpg")], {
        description: "Export format",
      }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const apiKey = await getCanvaApiKey(credentialStore);
        const designId = params.designId as string;
        const format = params.format as string;

        const createResponse = await fetch(
          `https://api.canva.com/rest/v1/designs/${designId}/exports`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ format: { type: format } }),
          },
        );

        if (!createResponse.ok) {
          const errBody = await createResponse.text();
          return textResult(`Canva export error (${createResponse.status}): ${errBody}`);
        }

        const createData = (await createResponse.json()) as { job?: { id?: string } };
        const exportJobId = createData.job?.id;
        if (!exportJobId) return textResult("Error: Canva did not return an export job ID");

        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2_000));

          const pollResponse = await fetch(
            `https://api.canva.com/rest/v1/designs/${designId}/exports/${exportJobId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );

          if (!pollResponse.ok) continue;

          const pollData = (await pollResponse.json()) as {
            job?: { status?: string; urls?: string[] };
          };
          const job = pollData.job;

          if (job?.status === "success" && job.urls?.length) {
            const exportUrl = job.urls[0]!;
            return textResult(
              [`Export complete.`, `Format: ${format}`, `URL: ${exportUrl}`].join("\n"),
              { exportUrl, format, designId, exportJobId },
            );
          }

          if (job?.status === "failed") {
            return textResult(`Export job failed. Job ID: ${exportJobId}`);
          }
        }

        return textResult(
          `Export timed out after 60s. Job ID: ${exportJobId} — retry with the same designId.`,
          { exportJobId, designId, format },
        );
      } catch (err) {
        return textResult(`Error exporting Canva design: ${errorMessage(err)}`);
      }
    },
  };

  const figmaGet: ToolEntry = {
    name: "figma_get",
    source: "local",
    description:
      "Get the structure of a Figma file: top-level frames and components. Read-only. Use the file key from the Figma URL: figma.com/file/{key}/...",
    parameters: Type.Object({
      fileKey: Type.String({ description: "The Figma file key (from the URL)" }),
      nodeId: Type.Optional(
        Type.String({
          description:
            "Optional node ID to scope the response to a specific frame or component",
        }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const token = await getFigmaAccessToken(credentialStore);
        const fileKey = params.fileKey as string;
        const nodeId = params.nodeId as string | undefined;

        const url = nodeId
          ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
          : `https://api.figma.com/v1/files/${fileKey}`;

        const response = await fetch(url, { headers: { "X-Figma-Token": token } });

        if (!response.ok) {
          const errBody = await response.text();
          return textResult(`Figma API error (${response.status}): ${errBody}`);
        }

        const data = (await response.json()) as {
          name?: string;
          document?: { children?: Array<{ id: string; name: string; type: string }> };
          nodes?: Record<string, { document?: { id: string; name: string; type: string } }>;
        };

        if (nodeId && data.nodes) {
          const node = Object.values(data.nodes)[0]?.document;
          return textResult(
            `Node: ${node?.name ?? "(unknown)"} (${node?.type ?? "?"}) ID: ${node?.id ?? nodeId}`,
            { node },
          );
        }

        const children = data.document?.children ?? [];
        const frames = children.filter((c) => c.type === "FRAME" || c.type === "CANVAS");
        const components = children.filter((c) => c.type === "COMPONENT");

        return textResult(
          [
            `File: ${data.name ?? "(untitled)"}`,
            `Frames (${frames.length}): ${frames.map((f) => `${f.name} (${f.id})`).join(", ") || "(none)"}`,
            `Components (${components.length}): ${components.map((c) => `${c.name} (${c.id})`).join(", ") || "(none)"}`,
          ].join("\n"),
          { name: data.name, frames, components },
        );
      } catch (err) {
        return textResult(`Error fetching Figma file: ${errorMessage(err)}`);
      }
    },
  };

  const figmaExport: ToolEntry = {
    name: "figma_export",
    source: "local",
    description: "Export one or more Figma nodes as image URLs (PNG, SVG, or PDF).",
    parameters: Type.Object({
      fileKey: Type.String({ description: "The Figma file key" }),
      nodeIds: Type.Array(Type.String(), { description: "List of node IDs to export" }),
      format: Type.Union([Type.Literal("png"), Type.Literal("svg"), Type.Literal("pdf")], {
        description: "Export format",
      }),
      scale: Type.Optional(
        Type.Number({ description: "Scale factor for PNG (e.g. 2 for 2x). Defaults to 1." }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const token = await getFigmaAccessToken(credentialStore);
        const fileKey = params.fileKey as string;
        const nodeIds = params.nodeIds as string[];
        const format = params.format as string;
        const scale = (params.scale as number | undefined) ?? 1;

        const idsParam = nodeIds.map(encodeURIComponent).join(",");
        const url = `https://api.figma.com/v1/images/${fileKey}?ids=${idsParam}&format=${format}&scale=${scale}`;

        const response = await fetch(url, { headers: { "X-Figma-Token": token } });

        if (!response.ok) {
          const errBody = await response.text();
          return textResult(`Figma API error (${response.status}): ${errBody}`);
        }

        const data = (await response.json()) as {
          images?: Record<string, string | null>;
        };
        const images = data.images ?? {};

        const lines = Object.entries(images).map(([id, imgUrl]) =>
          imgUrl ? `${id}: ${imgUrl}` : `${id}: (failed)`,
        );

        return textResult(
          `Exported ${lines.length} node(s) as ${format}:\n${lines.join("\n")}`,
          { images, format, fileKey },
        );
      } catch (err) {
        return textResult(`Error exporting Figma nodes: ${errorMessage(err)}`);
      }
    },
  };

  return [generateImage, canvaCreate, canvaGet, canvaExport, figmaGet, figmaExport];
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors in `graphic-designer-tools.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/graphic-designer-tools.ts
git commit -m "feat: add graphic-designer-tools module (Gemini ImageGen, Canva, Figma)"
```

---

## Task 2: Register the agent in `packages/core/agents.ts`

**Files:**
- Modify: `packages/core/agents.ts`

- [ ] **Step 1: Add the import at the top of the file (after the marketing import)**

Find this line:
```typescript
import { createMarketingToolEntries } from "./marketing-tools";
```

Add after it:
```typescript
import { createGraphicDesignerToolEntries } from "./graphic-designer-tools";
```

- [ ] **Step 2: Add the marketing → graphic-designer delegation**

Find this line (inside the marketing agent definition):
```typescript
    .canDelegateTo(["writer", "explorer", "secretary"], { maxDepth: 2 })
```

Replace with:
```typescript
    .canDelegateTo(["writer", "explorer", "secretary", "graphic-designer"], { maxDepth: 2 })
```

- [ ] **Step 3: Add the graphic-designer line to the orchestrator system prompt**

Find this line in the orchestrator system prompt array:
```typescript
      "The marketing specialist handles SEO audits, keyword research, competitor analysis, and content calendar management via Google Sheets. It can delegate to writer/explorer/secretary.",
```

Add after it:
```typescript
      "The graphic-designer specialist creates visual content: generates images with Gemini ImageGen, creates and exports Canva designs (poster, social_media, banner, presentation), and reads/exports Figma assets. It can delegate to explorer.",
```

- [ ] **Step 4: Add the graphic-designer agent definition**

Find this block at the bottom of `createAgentDefinitions`, just before the `return` statement:
```typescript
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner, marketing];
```

Add the agent definition immediately above that return line:

```typescript
  const explorerToolsForGraphicDesigner = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const searchWebForGraphicDesigner = explorerToolsForGraphicDesigner.filter(
    (t) => t.name === "search_web",
  );
  const browseUrlForGraphicDesigner = explorerToolsForGraphicDesigner.filter(
    (t) => t.name === "browse_url",
  );
  const graphicDesignerTools = createGraphicDesignerToolEntries({
    credentialStore: opts?.credentialStore,
  });

  const graphicDesigner = defineAgent("graphic-designer")
    .name("Graphic Designer")
    .role(
      "Visual creative: generates images with Gemini ImageGen, creates Canva designs, reads and exports Figma assets.",
    )
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      [
        "You are a graphic designer agent — a virtual creative director.",
        "You create visual content: generate images with AI, build designs in Canva, and extract assets from Figma.",
        "",
        "Your tools:",
        "- generate_image: Generate an image from a text prompt using Gemini ImageGen (Imagen 3). Supports style hints and aspect ratios (1:1, 16:9, 9:16, 4:3).",
        "- canva_create: Create a new Canva design (poster, social_media, banner, presentation). Returns designId and edit URL.",
        "- canva_get: Get details of an existing Canva design (title, thumbnail, edit/view URLs).",
        "- canva_export: Export a Canva design to PDF, PNG, or JPG. Polls until ready (60s timeout).",
        "- figma_get: Read a Figma file's structure — frames and components. Read-only.",
        "- figma_export: Export Figma nodes as PNG, SVG, or PDF URLs.",
        "- search_web: Search the web for visual references and inspiration.",
        "- browse_url: Fetch page content for reference imagery and competitor visual analysis.",
        "",
        "Delegation:",
        "- Delegate to 'explorer' for deep multi-page visual research or when you need to navigate complex sites for references.",
        "",
        "Workflow:",
        "1. Clarify the format and dimensions if not specified.",
        "2. Choose the right tool: generate_image for pure AI generation, canva_* for designed pieces, figma_* for design system assets.",
        "3. Use search_web or browse_url to gather visual references when helpful.",
        "4. Always return a usable URL or link to the created asset in your final answer.",
        "",
        "Be concise. Return the output link/URL prominently in your final answer.",
      ].join("\n"),
    )
    .capabilities([
      "image-generation",
      "canva-design",
      "figma-export",
      "visual-research",
      "poster",
      "banner",
      "social-media",
    ])
    .localToolEntries([
      ...graphicDesignerTools,
      ...searchWebForGraphicDesigner,
      ...browseUrlForGraphicDesigner,
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
    .build();
```

- [ ] **Step 5: Add `graphicDesigner` to the return array**

Replace:
```typescript
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner, marketing];
```

With:
```typescript
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner, marketing, graphicDesigner];
```

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/agents.ts
git commit -m "feat: add graphic-designer agent to runtime (Gemini ImageGen + Canva + Figma)"
```

---

## Task 3: Add UI personality to `apps/web/types.ts`

**Files:**
- Modify: `apps/web/types.ts`

- [ ] **Step 1: Add the personality entry**

Find:
```typescript
  marketing:      { accent: "#69ff94", badge: "K", tagline: "growth is the game" },
```

Add after it:
```typescript
  "graphic-designer": { accent: "#ffd700", badge: "G", tagline: "pixels with purpose" },
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/types.ts
git commit -m "feat: add graphic-designer UI personality (gold accent, G badge)"
```

---

## Task 4: Wire the smoke test

**Files:**
- Modify: `packages/core/runtime.ts`
- Modify: `apps/cli/index.ts`

- [ ] **Step 1: Extend the `runSmokeScenario` type union in `runtime.ts`**

Find:
```typescript
    async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger" | "web-designer" | "marketing") {
```

Replace with:
```typescript
    async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger" | "web-designer" | "marketing" | "graphic-designer") {
```

- [ ] **Step 2: Add the smoke case inside the same function**

Find:
```typescript
        if (name === "marketing") {
            return this.chat({
                toAgentId: "marketing",
                content: "Audit the SEO of https://example.com and list the top issues found.",
            });
        }
```

Add after it:
```typescript
        if (name === "graphic-designer") {
            return this.chat({
                toAgentId: "graphic-designer",
                content: "List the tools you have available and describe in one sentence what you can create with each one.",
            });
        }
```

- [ ] **Step 3: Add `"graphic-designer"` to `VALID_SMOKES` in `apps/cli/index.ts`**

Find:
```typescript
const VALID_SMOKES = ["math", "code", "orchestrator", "explorer", "writer", "debugger", "web-designer", "marketing"] as const;
```

Replace with:
```typescript
const VALID_SMOKES = ["math", "code", "orchestrator", "explorer", "writer", "debugger", "web-designer", "marketing", "graphic-designer"] as const;
```

- [ ] **Step 4: Update the help text in `apps/cli/index.ts`**

Find:
```typescript
                console.log("  /smoke <name>          corre smoke (math|code|orchestrator|explorer|writer|debugger|web-designer)");
```

Replace with:
```typescript
                console.log("  /smoke <name>          corre smoke (math|code|orchestrator|explorer|writer|debugger|web-designer|marketing|graphic-designer)");
```

- [ ] **Step 5: Update the error message in the `/smoke` command handler**

Find:
```typescript
                    console.log("Uso: /smoke math|code|orchestrator|explorer|writer|debugger|web-designer|marketing");
```

Replace with:
```typescript
                    console.log("Uso: /smoke math|code|orchestrator|explorer|writer|debugger|web-designer|marketing|graphic-designer");
```

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/runtime.ts apps/cli/index.ts
git commit -m "feat: add graphic-designer smoke test"
```

---

## Task 5: Add `smoke:graphic-designer` npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

Find the `smoke:marketing` line in `package.json`:
```json
"smoke:marketing": "bun run apps/cli/index.ts --smoke marketing",
```

Add after it:
```json
"smoke:graphic-designer": "bun run apps/cli/index.ts --smoke graphic-designer",
```

- [ ] **Step 2: Run the smoke test (no credentials needed — tests tool listing)**

```bash
bun run smoke:graphic-designer
```

Expected output: the agent replies listing its tools (generate_image, canva_create, canva_get, canva_export, figma_get, figma_export) with one-sentence descriptions. No API calls made.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add smoke:graphic-designer script"
```

---

## Task 6: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Find the `marketing` line in the Model Configuration section:
```
- `marketing` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url`; delegates to `writer`, `explorer`, `secretary`)
```

Add after it:
```
- `graphic-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: `generate_image`, `canva_create`, `canva_get`, `canva_export`, `figma_get`, `figma_export`, `search_web`, `browse_url`; delegates to `explorer`)
```

Also add to the tools file list (find `Marketing tools:` and add after the marketing block):
```
- Graphic designer tools: `packages/core/graphic-designer-tools.ts` (`generate_image` via Gemini Imagen 3; `canva_create`, `canva_get`, `canva_export` via Canva Connect API; `figma_get`, `figma_export` via Figma REST API — assigned to `graphic-designer`)
```

And add to the credential/prereqs section:
```
Graphic designer prerequisites:
- `GEMINI_API_KEY` env var or CredentialStore domain `"gemini"` (field: `apiKey`) — Google AI Studio key for Imagen 3
- `CANVA_API_KEY` env var or CredentialStore domain `"canva"` (field: `apiKey`) — Canva Connect API key
- `FIGMA_ACCESS_TOKEN` env var or CredentialStore domain `"figma"` (field: `accessToken`) — Figma personal access token
```

And add smoke script reference:
```
- `bun run smoke:graphic-designer`
```

- [ ] **Step 2: Update `README.md`**

Add `graphic-designer` to the agent table (find the `marketing` row and add after):

```markdown
| `graphic-designer` | Graphic Designer | Gemini ImageGen, Canva designs, Figma asset export | `generate_image`, `canva_*`, `figma_*`, `search_web`, `browse_url` |
```

- [ ] **Step 3: Update `AGENTS.md`**

Add the graphic-designer agent entry following the same format as the other agents in that file.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "docs: document graphic-designer agent"
```

---

## Self-Review Checklist

- [x] All 6 tools in `graphic-designer-tools.ts` have `source`, `description`, `parameters`, `defaultPermission`, `available`, `execute`
- [x] Credential helper pattern matches `marketing-tools.ts` style (CredentialStore.get → env var → throw)
- [x] `canva_export` polling uses `setTimeout` (not `sleep`) and respects 60s deadline
- [x] `figma_get` handles both full-file and single-node paths
- [x] Return array in `agents.ts` includes `graphicDesigner`
- [x] Marketing `.canDelegateTo()` includes `"graphic-designer"`
- [x] `AGENT_PERSONALITIES` accent `#ffd700` does not conflict with any existing agent
- [x] `VALID_SMOKES` updated in both `runtime.ts` type union and `cli/index.ts` array
- [x] Smoke prompt does not require credentials (tests tool listing only)
- [x] `createExplorerToolEntries` called with separate variable to avoid cross-contamination with other agents' explorer instances
