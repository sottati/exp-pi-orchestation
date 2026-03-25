import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleSheetsToolOptions {
  credentialStore?: CredentialStore;
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 500;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createGoogleSheetsToolEntries(opts?: GoogleSheetsToolOptions): ToolEntry[] {
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;

  const readSheet: ToolEntry = {
    name: "read_gsheet",
    source: "local",
    description: "Read data from a Google Sheets spreadsheet. Returns rows as JSON. Can target a specific sheet/range.",
    parameters: Type.Object({
      spreadsheetId: Type.String({ description: "The spreadsheet ID (from the URL)" }),
      range: Type.Optional(Type.String({ description: "A1 notation range (e.g. 'Sheet1!A1:D10'). Default: first sheet, all data." })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const spreadsheetId = params.spreadsheetId as string;
      const range = (params.range as string | undefined) ?? "";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const sheets = google.sheets({ version: "v4", auth });

        // If no range, get spreadsheet metadata to find first sheet
        let queryRange = range;
        if (!queryRange) {
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const firstSheet = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
          queryRange = firstSheet;
        }

        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: queryRange });
        const allValues = res.data.values ?? [];

        if (allValues.length === 0) {
          return textResult(JSON.stringify({ spreadsheetId, range: queryRange, columns: [], rowCount: 0, rows: [] }));
        }

        const headers = allValues[0] as string[];
        const dataRows = allValues.slice(1);
        const rows: Record<string, unknown>[] = [];

        for (const row of dataRows) {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < headers.length; i++) {
            obj[headers[i]!] = row[i] ?? null;
          }
          rows.push(obj);
        }

        const truncated = rows.length > maxRows;
        const resultRows = truncated ? rows.slice(0, maxRows) : rows;

        const resultData = {
          spreadsheetId,
          range: queryRange,
          columns: headers,
          rowCount: dataRows.length,
          truncated,
          maxRows,
          rows: resultRows,
        };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const writeSheet: ToolEntry = {
    name: "write_gsheet",
    source: "local",
    description: "Write data to a Google Sheets spreadsheet. Appends rows or overwrites a range.",
    parameters: Type.Object({
      spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
      range: Type.String({ description: "A1 notation range to write to (e.g. 'Sheet1!A1')" }),
      values: Type.Array(Type.Array(Type.Any()), { description: "2D array of values (rows × columns)" }),
      mode: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
        description: "Write mode: 'overwrite' replaces the range, 'append' adds after existing data. Default: overwrite.",
      })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const spreadsheetId = params.spreadsheetId as string;
      const range = params.range as string;
      const values = params.values as unknown[][];
      const mode = (params.mode as "overwrite" | "append") ?? "overwrite";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const sheets = google.sheets({ version: "v4", auth });

        if (mode === "append") {
          const res = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
          });
          const updated = res.data.updates;
          const resultData = {
            spreadsheetId, range, mode, rowsWritten: values.length,
            updatedRange: updated?.updatedRange,
          };
          return textResult(`Appended ${values.length} rows to ${range}`, resultData);
        } else {
          const res = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
          });
          const resultData = {
            spreadsheetId, range, mode, rowsWritten: values.length,
            updatedCells: res.data.updatedCells,
          };
          return textResult(`Wrote ${values.length} rows to ${range}`, resultData);
        }
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const createSheet: ToolEntry = {
    name: "create_gsheet",
    source: "local",
    description: "Create a new Google Sheets spreadsheet with optional initial data.",
    parameters: Type.Object({
      title: Type.String({ description: "Title of the new spreadsheet" }),
      sheetName: Type.Optional(Type.String({ description: "Name of the first sheet (default: 'Sheet1')" })),
      headers: Type.Optional(Type.Array(Type.String(), { description: "Column headers for the first row" })),
      rows: Type.Optional(Type.Array(Type.Array(Type.Any()), { description: "Initial data rows" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const title = params.title as string;
      const sheetName = (params.sheetName as string) ?? "Sheet1";
      const headers = params.headers as string[] | undefined;
      const rows = params.rows as unknown[][] | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const sheets = google.sheets({ version: "v4", auth });

        const createRes = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [{ properties: { title: sheetName } }],
          },
        });

        const spreadsheetId = createRes.data.spreadsheetId!;
        const url = createRes.data.spreadsheetUrl!;

        // Write initial data if provided
        if (headers || rows) {
          const values: unknown[][] = [];
          if (headers) values.push(headers);
          if (rows) values.push(...rows);

          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
          });
        }

        const resultData = { spreadsheetId, title, sheetName, url, rowCount: rows?.length ?? 0 };
        return textResult(`Created spreadsheet "${title}": ${url}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [readSheet, writeSheet, createSheet];
}
