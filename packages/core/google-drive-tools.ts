import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleDriveToolOptions {
  credentialStore?: CredentialStore;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createGoogleDriveToolEntries(opts?: GoogleDriveToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const driveList: ToolEntry = {
    name: "drive_list",
    source: "local",
    description: "List files in Google Drive. Can filter by folder, file type, or query. Returns file names, IDs, types, and sizes.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Google Drive search query (e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\"). Default: list recent files." })),
      folderId: Type.Optional(Type.String({ description: "List files inside this folder ID" })),
      pageSize: Type.Optional(Type.Number({ description: `Max results to return (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = params.query as string | undefined;
      const folderId = params.folderId as string | undefined;
      const pageSize = Math.min((params.pageSize as number | undefined) ?? maxResults, maxResults);

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const drive = google.drive({ version: "v3", auth });

        let q = "trashed = false";
        if (folderId) q += ` and '${folderId}' in parents`;
        if (query) q += ` and (${query})`;

        const res = await drive.files.list({
          q,
          pageSize,
          fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
          orderBy: "modifiedTime desc",
        });

        const files = (res.data.files ?? []).map(f => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
          modifiedTime: f.modifiedTime,
          url: f.webViewLink,
        }));

        const resultData = { fileCount: files.length, query: q, files };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const driveSearch: ToolEntry = {
    name: "drive_search",
    source: "local",
    description: "Search for files in Google Drive by name or content. Returns matching files with IDs and URLs.",
    parameters: Type.Object({
      term: Type.String({ description: "Search term to find in file names and content" }),
      mimeType: Type.Optional(Type.String({ description: "Filter by MIME type (e.g. 'application/pdf', 'application/vnd.google-apps.spreadsheet')" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const term = params.term as string;
      const mimeType = params.mimeType as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const drive = google.drive({ version: "v3", auth });

        let q = `trashed = false and fullText contains '${term.replace(/'/g, "\\'")}'`;
        if (mimeType) q += ` and mimeType = '${mimeType}'`;

        const res = await drive.files.list({
          q,
          pageSize: maxResults,
          fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
          orderBy: "modifiedTime desc",
        });

        const files = (res.data.files ?? []).map(f => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
          modifiedTime: f.modifiedTime,
          url: f.webViewLink,
        }));

        const resultData = { term, fileCount: files.length, files };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const driveDownload: ToolEntry = {
    name: "drive_download",
    source: "local",
    description: "Download a file from Google Drive to the local filesystem. Supports regular files and Google Workspace exports.",
    parameters: Type.Object({
      fileId: Type.String({ description: "The file ID to download" }),
      outputPath: Type.String({ description: "Local path to save the downloaded file" }),
      exportMimeType: Type.Optional(Type.String({ description: "For Google Workspace files, export as this MIME type (e.g. 'application/pdf', 'text/plain', 'text/csv')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const fileId = params.fileId as string;
      const outputPath = params.outputPath as string;
      const exportMimeType = params.exportMimeType as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const drive = google.drive({ version: "v3", auth });

        // Get file metadata first
        const meta = await drive.files.get({ fileId, fields: "name,mimeType,size" });
        const isGoogleFile = meta.data.mimeType?.startsWith("application/vnd.google-apps.");

        let data: ArrayBuffer;
        if (isGoogleFile || exportMimeType) {
          const mime = exportMimeType ?? "application/pdf";
          const res = await drive.files.export({ fileId, mimeType: mime }, { responseType: "arraybuffer" });
          data = res.data as unknown as ArrayBuffer;
        } else {
          const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
          data = res.data as unknown as ArrayBuffer;
        }

        await Bun.write(outputPath, data);

        const resultData = {
          fileId,
          fileName: meta.data.name,
          mimeType: meta.data.mimeType,
          outputPath,
          bytesWritten: data.byteLength,
        };
        return textResult(`Downloaded "${meta.data.name}" to ${outputPath} (${data.byteLength} bytes)`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [driveList, driveSearch, driveDownload];
}
