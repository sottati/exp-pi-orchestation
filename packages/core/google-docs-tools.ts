import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleDocsToolOptions {
  credentialStore?: CredentialStore;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Extract plain text from a Google Docs document body. */
function extractText(body: any): string {
  const parts: string[] = [];
  for (const el of body?.content ?? []) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? [])
        .map((e: any) => e.textRun?.content ?? "")
        .join("");
      parts.push(line);
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell: any) => {
          return (cell.content ?? [])
            .flatMap((c: any) => (c.paragraph?.elements ?? []).map((e: any) => e.textRun?.content ?? ""))
            .join("")
            .trim();
        });
        parts.push(cells.join("\t"));
      }
    }
  }
  return parts.join("");
}

export function createGoogleDocsToolEntries(opts?: GoogleDocsToolOptions): ToolEntry[] {

  const readDoc: ToolEntry = {
    name: "read_gdoc",
    source: "local",
    description: "Read a Google Docs document and return its text content.",
    parameters: Type.Object({
      documentId: Type.String({ description: "The document ID (from the URL)" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const documentId = params.documentId as string;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const docs = google.docs({ version: "v1", auth });

        const res = await docs.documents.get({ documentId });
        const doc = res.data;
        const content = extractText(doc.body);
        const title = doc.title ?? "Untitled";

        const resultData = { documentId, title, length: content.length };
        return textResult(content, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const writeDoc: ToolEntry = {
    name: "write_gdoc",
    source: "local",
    description: "Insert or replace text in a Google Docs document. Can append text at the end or replace all content.",
    parameters: Type.Object({
      documentId: Type.String({ description: "The document ID" }),
      text: Type.String({ description: "Text to insert" }),
      mode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")], {
        description: "'append' adds text at the end, 'replace' clears and writes. Default: append.",
      })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const documentId = params.documentId as string;
      const text = params.text as string;
      const mode = (params.mode as "append" | "replace") ?? "append";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const docs = google.docs({ version: "v1", auth });

        const requests: any[] = [];

        if (mode === "replace") {
          // Get current doc to find content length
          const doc = await docs.documents.get({ documentId });
          const body = doc.data.body;
          const endIndex = body?.content?.at(-1)?.endIndex ?? 1;
          if (endIndex > 1) {
            requests.push({
              deleteContentRange: {
                range: { startIndex: 1, endIndex: endIndex - 1 },
              },
            });
          }
        }

        // Get insertion index (end of doc for append, start for replace)
        if (mode === "append") {
          const doc = await docs.documents.get({ documentId });
          const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;
          requests.push({
            insertText: { location: { index: endIndex - 1 }, text },
          });
        } else {
          requests.push({
            insertText: { location: { index: 1 }, text },
          });
        }

        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests },
        });

        const resultData = { documentId, mode, textLength: text.length };
        return textResult(`${mode === "replace" ? "Replaced" : "Appended"} ${text.length} characters in document`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const createDoc: ToolEntry = {
    name: "create_gdoc",
    source: "local",
    description: "Create a new Google Docs document with optional initial text content.",
    parameters: Type.Object({
      title: Type.String({ description: "Title of the new document" }),
      text: Type.Optional(Type.String({ description: "Initial text content" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const title = params.title as string;
      const text = params.text as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const docs = google.docs({ version: "v1", auth });

        const createRes = await docs.documents.create({
          requestBody: { title },
        });

        const documentId = createRes.data.documentId!;
        const url = `https://docs.google.com/document/d/${documentId}/edit`;

        if (text) {
          await docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [{ insertText: { location: { index: 1 }, text } }],
            },
          });
        }

        const resultData = { documentId, title, url, textLength: text?.length ?? 0 };
        return textResult(`Created document "${title}": ${url}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [readDoc, writeDoc, createDoc];
}
