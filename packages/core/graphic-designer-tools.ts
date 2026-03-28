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
    const key = cred?.["apiKey"];
    if (key) return key;
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
    const key = cred?.["apiKey"];
    if (key) return key;
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
    const token = cred?.["accessToken"];
    if (token) return token;
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
    description: "Create a new Canva design (blank or from a design type). Returns the design ID and edit URL.",
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
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const apiKey = await getCanvaApiKey(credentialStore);
        const title = params.title as string;
        const designType = params.designType as string;

        const body: Record<string, unknown> = {
          title,
          design_type: { type: designType },
        };

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

          if (!pollResponse.ok) {
            if (pollResponse.status < 500) {
              const errBody = await pollResponse.text();
              return textResult(`Canva poll error (${pollResponse.status}): ${errBody}`);
            }
            continue;
          }

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
        const pages = children.filter((c) => c.type === "CANVAS");
        const frames = children.filter((c) => c.type === "FRAME");
        const components = children.filter((c) => c.type === "COMPONENT");

        return textResult(
          [
            `File: ${data.name ?? "(untitled)"}`,
            `Pages (${pages.length}): ${pages.map((f) => `${f.name} (${f.id})`).join(", ") || "(none)"}`,
            `Frames (${frames.length}): ${frames.map((f) => `${f.name} (${f.id})`).join(", ") || "(none)"}`,
            `Components (${components.length}): ${components.map((c) => `${c.name} (${c.id})`).join(", ") || "(none)"}`,
          ].join("\n"),
          { name: data.name, pages, frames, components },
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
