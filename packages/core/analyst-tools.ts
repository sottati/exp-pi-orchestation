import { Type } from "@sinclair/typebox";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";

export interface AnalystToolOptions {
  maxRows?: number;
  maxCsvSizeMB?: number;
  supabaseUrl?: string;
}

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_CSV_SIZE_MB = 10;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function truncateRows(rows: unknown[], limit: number): { rows: unknown[]; truncated: boolean } {
  if (rows.length <= limit) return { rows, truncated: false };
  return { rows: rows.slice(0, limit), truncated: true };
}

export function createAnalystToolEntries(opts?: AnalystToolOptions): ToolEntry[] {
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCsvSizeMB = opts?.maxCsvSizeMB ?? DEFAULT_MAX_CSV_SIZE_MB;

  const querySqlite: ToolEntry = {
    name: "query_sqlite",
    source: "local",
    description: "Execute a read-only SQL query against a SQLite database file. Returns rows as JSON.",
    parameters: Type.Object({
      dbPath: Type.String({ description: "Path to the SQLite database file" }),
      query: Type.String({ description: "SQL query to execute (SELECT only)" }),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const dbPath = params.dbPath as string;
      const query = (params.query as string).trim();

      // Safety: only allow read queries
      const firstWord = query.split(/\s+/)[0]?.toUpperCase();
      const readOnlyKeywords = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];
      if (!firstWord || !readOnlyKeywords.includes(firstWord)) {
        return textResult(
          `Error: Only read-only queries are allowed (SELECT, PRAGMA, EXPLAIN, WITH). Got: ${firstWord}`,
        );
      }

      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const stmt = db.prepare(query);
          const allRows = stmt.all() as unknown[];
          const { rows, truncated } = truncateRows(allRows, maxRows);
          const resultData = { rowCount: allRows.length, truncated, maxRows, rows };
          return textResult(JSON.stringify(resultData, null, 2), resultData);
        } finally {
          db.close();
        }
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const parseCsv: ToolEntry = {
    name: "parse_csv",
    source: "local",
    description: "Parse a CSV file and return its contents as structured JSON rows. Supports custom delimiters.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the CSV file" }),
      delimiter: Type.Optional(Type.String({ description: "Column delimiter (default: comma)" })),
      hasHeader: Type.Optional(Type.Boolean({ description: "Whether the first row is a header (default: true)" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const delimiter = (params.delimiter as string) ?? ",";
      const hasHeader = (params.hasHeader as boolean) ?? true;

      try {
        const file = Bun.file(filePath);
        const size = file.size;
        if (size > maxCsvSizeMB * 1024 * 1024) {
          return textResult(
            `Error: File too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${maxCsvSizeMB}MB limit`,
          );
        }

        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

        if (lines.length === 0) {
          const empty = { rowCount: 0, columns: [] as string[], rows: [] as unknown[] };
          return textResult(JSON.stringify(empty, null, 2), empty);
        }

        const parseLine = (line: string): string[] => {
          const fields: string[] = [];
          let current = "";
          let inQuotes = false;

          for (let i = 0; i < line.length; i++) {
            const char = line[i]!;
            if (inQuotes) {
              if (char === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
              } else if (char === '"') {
                inQuotes = false;
              } else {
                current += char;
              }
            } else {
              if (char === '"') {
                inQuotes = true;
              } else if (char === delimiter) {
                fields.push(current.trim());
                current = "";
              } else {
                current += char;
              }
            }
          }
          fields.push(current.trim());
          return fields;
        };

        let columns: string[];
        let dataLines: string[];

        if (hasHeader) {
          columns = parseLine(lines[0]!);
          dataLines = lines.slice(1);
        } else {
          const firstLine = parseLine(lines[0]!);
          columns = firstLine.map((_, i) => `col_${i}`);
          dataLines = lines;
        }

        const allRows = dataLines.map(line => {
          const values = parseLine(line);
          const row: Record<string, string> = {};
          for (let i = 0; i < columns.length; i++) {
            row[columns[i]!] = values[i] ?? "";
          }
          return row;
        });

        const { rows, truncated } = truncateRows(allRows, maxRows);
        const resultData = { rowCount: allRows.length, columns, truncated, maxRows, rows };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const analyzeData: ToolEntry = {
    name: "analyze_data",
    source: "local",
    description: "Compute summary statistics (count, min, max, mean, median, unique) for numeric and text columns in a JSON dataset.",
    parameters: Type.Object({
      data: Type.Array(Type.Record(Type.String(), Type.Any()), {
        description: "Array of row objects to analyze",
      }),
      columns: Type.Optional(Type.Array(Type.String(), {
        description: "Specific columns to analyze (default: all)",
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const data = params.data as Record<string, unknown>[];
        if (!Array.isArray(data) || data.length === 0) {
          return textResult("Error: No data provided or empty array");
        }

        const targetColumns = (params.columns as string[]) ?? Object.keys(data[0]!);
        const stats: Record<string, unknown> = {};

        for (const col of targetColumns) {
          const values = data.map(row => row[col]).filter(v => v !== undefined && v !== null && v !== "");
          const numericValues = values
            .map(v => typeof v === "number" ? v : parseFloat(String(v)))
            .filter(n => !isNaN(n));

          if (numericValues.length > 0) {
            numericValues.sort((a, b) => a - b);
            const sum = numericValues.reduce((a, b) => a + b, 0);
            const mid = Math.floor(numericValues.length / 2);
            const median = numericValues.length % 2 === 0
              ? (numericValues[mid - 1]! + numericValues[mid]!) / 2
              : numericValues[mid]!;

            stats[col] = {
              type: "numeric",
              count: values.length,
              numericCount: numericValues.length,
              min: numericValues[0],
              max: numericValues[numericValues.length - 1],
              mean: +(sum / numericValues.length).toFixed(4),
              median,
              unique: new Set(numericValues).size,
            };
          } else {
            const uniqueValues = new Set(values.map(String));
            stats[col] = {
              type: "text",
              count: values.length,
              unique: uniqueValues.size,
              sample: [...uniqueValues].slice(0, 5),
            };
          }
        }

        const resultData = { rowCount: data.length, columns: targetColumns, stats };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const querySupabase: ToolEntry = {
    name: "query_supabase",
    source: "local",
    description: "Execute a read-only SQL query against a Supabase (PostgreSQL) database. Uses DATABASE_URL from environment or explicit connection string. Returns rows as JSON.",
    parameters: Type.Object({
      query: Type.String({ description: "SQL query to execute (SELECT only)" }),
      connectionUrl: Type.Optional(Type.String({ description: "PostgreSQL connection URL (default: DATABASE_URL env var)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = (params.query as string).trim();

      // Safety: only allow read queries (check before connecting)
      const firstWord = query.split(/\s+/)[0]?.toUpperCase();
      const readOnlyKeywords = ["SELECT", "EXPLAIN", "WITH"];
      if (!firstWord || !readOnlyKeywords.includes(firstWord)) {
        return textResult(
          `Error: Only read-only queries are allowed (SELECT, EXPLAIN, WITH). Got: ${firstWord}`,
        );
      }

      const connUrl = (params.connectionUrl as string | undefined) ?? opts?.supabaseUrl ?? process.env.DATABASE_URL;

      if (!connUrl) {
        return textResult(
          "Error: No connection URL provided. Set DATABASE_URL in .env or pass connectionUrl parameter.",
        );
      }

      let db: InstanceType<typeof SQL> | undefined;
      try {
        db = new SQL({ url: connUrl, connectTimeout: 10 });
        const allRows = await db.unsafe(query) as unknown[];
        const { rows, truncated } = truncateRows(allRows, maxRows);
        const resultData = { rowCount: allRows.length, truncated, maxRows, rows };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      } finally {
        if (db) await db.close();
      }
    },
  };

  return [querySqlite, querySupabase, parseCsv, analyzeData];
}
