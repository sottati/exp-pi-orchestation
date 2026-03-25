import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";

export interface OfficeToolOptions {
  maxFileSizeMB?: number;
  maxRows?: number;
}

const DEFAULT_MAX_FILE_SIZE_MB = 50;
const DEFAULT_MAX_ROWS = 500;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

// ─── Excel tools (analyst) ───────────────────────────────────────────

export function createExcelToolEntries(opts?: OfficeToolOptions): ToolEntry[] {
  const maxFileSizeMB = opts?.maxFileSizeMB ?? DEFAULT_MAX_FILE_SIZE_MB;
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;

  const readExcel: ToolEntry = {
    name: "read_excel",
    source: "local",
    description: "Read an Excel (.xlsx) file. Returns sheet names and row data as JSON. Can target a specific sheet.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the .xlsx file" }),
      sheet: Type.Optional(Type.String({ description: "Sheet name to read (default: first sheet)" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const sheetName = params.sheet as string | undefined;

      try {
        const file = Bun.file(filePath);
        const size = file.size;
        if (size > maxFileSizeMB * 1024 * 1024) {
          return textResult(`Error: File too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${maxFileSizeMB}MB limit`);
        }

        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        const buffer = await file.arrayBuffer();
        await workbook.xlsx.load(Buffer.from(new Uint8Array(buffer)) as any);

        const sheetNames = workbook.worksheets.map(ws => ws.name);
        const ws = sheetName
          ? workbook.getWorksheet(sheetName)
          : workbook.worksheets[0];

        if (!ws) {
          return textResult(`Error: Sheet "${sheetName}" not found. Available sheets: ${sheetNames.join(", ")}`);
        }

        const headers: string[] = [];
        const firstRow = ws.getRow(1);
        firstRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber - 1] = cell.text || `col_${colNumber}`;
        });

        const allRows: Record<string, unknown>[] = [];
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber === 1) return; // skip header
          const rowData: Record<string, unknown> = {};
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const key = headers[colNumber - 1] ?? `col_${colNumber}`;
            rowData[key] = cell.value;
          });
          allRows.push(rowData);
        });

        const truncated = allRows.length > maxRows;
        const rows = truncated ? allRows.slice(0, maxRows) : allRows;
        const resultData = {
          filePath,
          sheetName: ws.name,
          sheetNames,
          columns: headers.filter(Boolean),
          rowCount: allRows.length,
          truncated,
          maxRows,
          rows,
        };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const writeExcel: ToolEntry = {
    name: "write_excel",
    source: "local",
    description: "Create an Excel (.xlsx) file from structured data. Takes column headers and row arrays.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Output path for the .xlsx file" }),
      sheetName: Type.Optional(Type.String({ description: "Sheet name (default: 'Sheet1')" })),
      columns: Type.Array(Type.String(), { description: "Column headers" }),
      rows: Type.Array(Type.Array(Type.Any()), { description: "Array of row arrays (values in column order)" }),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const sheetNameParam = (params.sheetName as string) ?? "Sheet1";
      const columns = params.columns as string[];
      const rows = params.rows as unknown[][];

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet(sheetNameParam);

        ws.columns = columns.map(header => ({ header, key: header }));
        for (const row of rows) {
          const rowObj: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            rowObj[columns[i]!] = row[i];
          }
          ws.addRow(rowObj);
        }

        const buffer = await workbook.xlsx.writeBuffer();
        await Bun.write(filePath, buffer);

        const resultData = { filePath, sheetName: sheetNameParam, columns, rowCount: rows.length };
        return textResult(`Excel file written: ${filePath} (${rows.length} rows, ${columns.length} columns)`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [readExcel, writeExcel];
}

// ─── Word tools (writer) ─────────────────────────────────────────────

export function createWordToolEntries(opts?: OfficeToolOptions): ToolEntry[] {
  const maxFileSizeMB = opts?.maxFileSizeMB ?? DEFAULT_MAX_FILE_SIZE_MB;

  const readDocx: ToolEntry = {
    name: "read_docx",
    source: "local",
    description: "Read a Word (.docx) file and extract its text content as markdown.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the .docx file" }),
      format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
        description: "Output format: 'markdown' (default) or 'text' (plain text)",
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const format = (params.format as "markdown" | "text") ?? "markdown";

      try {
        const file = Bun.file(filePath);
        const size = file.size;
        if (size > maxFileSizeMB * 1024 * 1024) {
          return textResult(`Error: File too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${maxFileSizeMB}MB limit`);
        }

        const mammoth = await import("mammoth");
        const buffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));

        let content: string;
        if (format === "text") {
          const result = await mammoth.extractRawText({ buffer: buffer as any });
          content = result.value;
        } else {
          const result = await (mammoth as any).convertToMarkdown({ buffer });
          content = result.value;
        }

        const resultData = { filePath, format, length: content.length };
        return textResult(content, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const writeDocx: ToolEntry = {
    name: "write_docx",
    source: "local",
    description: "Create a Word (.docx) file from structured content. Supports paragraphs with headings, bold, italic, and bullet lists.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Output path for the .docx file" }),
      content: Type.Array(Type.Object({
        type: Type.Union([
          Type.Literal("heading"),
          Type.Literal("paragraph"),
          Type.Literal("bullet"),
        ], { description: "Content block type" }),
        text: Type.String({ description: "Text content" }),
        level: Type.Optional(Type.Number({ description: "Heading level (1-3) for type 'heading'" })),
        bold: Type.Optional(Type.Boolean({ description: "Bold text" })),
        italic: Type.Optional(Type.Boolean({ description: "Italic text" })),
      }), { description: "Array of content blocks" }),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const contentBlocks = params.content as Array<{
        type: "heading" | "paragraph" | "bullet";
        text: string;
        level?: number;
        bold?: boolean;
        italic?: boolean;
      }>;

      try {
        const docx = await import("docx");

        const children: InstanceType<typeof docx.Paragraph>[] = [];

        for (const block of contentBlocks) {
          const runOpts: ConstructorParameters<typeof docx.TextRun>[0] = {
            text: block.text,
            bold: block.bold,
            italics: block.italic,
          };

          if (block.type === "heading") {
            const headingMap: Record<number, (typeof docx.HeadingLevel)[keyof typeof docx.HeadingLevel]> = {
              1: docx.HeadingLevel.HEADING_1,
              2: docx.HeadingLevel.HEADING_2,
              3: docx.HeadingLevel.HEADING_3,
            };
            children.push(new docx.Paragraph({
              heading: headingMap[block.level ?? 1] ?? docx.HeadingLevel.HEADING_1,
              children: [new docx.TextRun(runOpts)],
            }));
          } else if (block.type === "bullet") {
            children.push(new docx.Paragraph({
              bullet: { level: 0 },
              children: [new docx.TextRun(runOpts)],
            }));
          } else {
            children.push(new docx.Paragraph({
              children: [new docx.TextRun(runOpts)],
            }));
          }
        }

        const doc = new docx.Document({
          sections: [{ children }],
        });

        const buffer = await docx.Packer.toBuffer(doc);
        await Bun.write(filePath, buffer);

        const resultData = { filePath, blockCount: contentBlocks.length };
        return textResult(`Word file written: ${filePath} (${contentBlocks.length} blocks)`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [readDocx, writeDocx];
}
