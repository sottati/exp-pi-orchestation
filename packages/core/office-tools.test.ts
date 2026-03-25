import { test, expect, describe, afterAll } from "bun:test";
import { createExcelToolEntries, createWordToolEntries } from "./office-tools";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

function extractText(result: any): string {
  return result.content[0].text;
}

const testDir = join(tmpdir(), `office-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ─── Excel tool structure ────────────────────────────────────────────

describe("createExcelToolEntries", () => {
  test("returns 2 tools with correct names", () => {
    const entries = createExcelToolEntries();
    const names = entries.map(e => e.name);
    expect(names).toEqual(["read_excel", "write_excel"]);
  });

  test("read_excel has allow, write_excel has hitl permission", () => {
    const entries = createExcelToolEntries();
    expect(entries.find(e => e.name === "read_excel")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "write_excel")!.defaultPermission).toBe("hitl");
  });

  test("all tools have source local and are available", () => {
    const entries = createExcelToolEntries();
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });
});

// ─── Excel read/write roundtrip ──────────────────────────────────────

describe("Excel roundtrip", () => {
  const getWriteTool = () => createExcelToolEntries().find(e => e.name === "write_excel")!;
  const getReadTool = () => createExcelToolEntries().find(e => e.name === "read_excel")!;

  const xlsxPath = join(testDir, "test.xlsx");

  test("write_excel creates a file", async () => {
    const tool = getWriteTool();
    const raw = await tool.execute("tc1", {
      filePath: xlsxPath,
      columns: ["Name", "Age", "City"],
      rows: [
        ["Alice", 30, "NYC"],
        ["Bob", 25, "LA"],
      ],
    });
    const text = extractText(raw);
    expect(text).toContain("Excel file written");
    expect(text).toContain("2 rows");
    expect(raw.details.rowCount).toBe(2);
  });

  test("read_excel reads back the data", async () => {
    const tool = getReadTool();
    const raw = await tool.execute("tc2", { filePath: xlsxPath });
    const data = JSON.parse(extractText(raw));
    expect(data.sheetName).toBe("Sheet1");
    expect(data.columns).toEqual(["Name", "Age", "City"]);
    expect(data.rowCount).toBe(2);
    expect(data.rows[0].Name).toBe("Alice");
    expect(data.rows[1].City).toBe("LA");
  });

  test("read_excel with custom sheet name", async () => {
    // Write with custom sheet name
    const write = getWriteTool();
    const customPath = join(testDir, "custom-sheet.xlsx");
    await write.execute("tc3", {
      filePath: customPath,
      sheetName: "Data",
      columns: ["X"],
      rows: [[1]],
    });

    const read = getReadTool();
    const raw = await read.execute("tc4", { filePath: customPath, sheet: "Data" });
    const data = JSON.parse(extractText(raw));
    expect(data.sheetName).toBe("Data");
    expect(data.sheetNames).toContain("Data");
  });

  test("read_excel returns error for non-existent sheet", async () => {
    const tool = getReadTool();
    const raw = await tool.execute("tc5", { filePath: xlsxPath, sheet: "NoSuchSheet" });
    const text = extractText(raw);
    expect(text).toContain("not found");
  });

  test("read_excel returns error for non-existent file", async () => {
    const tool = getReadTool();
    const raw = await tool.execute("tc6", { filePath: join(testDir, "nope.xlsx") });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });

  test("read_excel respects maxRows", async () => {
    // Write a file with many rows
    const write = getWriteTool();
    const bigPath = join(testDir, "big.xlsx");
    const rows = Array.from({ length: 20 }, (_, i) => [i]);
    await write.execute("tc7", { filePath: bigPath, columns: ["N"], rows });

    const entries = createExcelToolEntries({ maxRows: 5 });
    const read = entries.find(e => e.name === "read_excel")!;
    const raw = await read.execute("tc8", { filePath: bigPath });
    const data = JSON.parse(extractText(raw));
    expect(data.truncated).toBe(true);
    expect(data.rows.length).toBe(5);
    expect(data.rowCount).toBe(20);
  });
});

// ─── Word tool structure ─────────────────────────────────────────────

describe("createWordToolEntries", () => {
  test("returns 2 tools with correct names", () => {
    const entries = createWordToolEntries();
    const names = entries.map(e => e.name);
    expect(names).toEqual(["read_docx", "write_docx"]);
  });

  test("read_docx has allow, write_docx has hitl permission", () => {
    const entries = createWordToolEntries();
    expect(entries.find(e => e.name === "read_docx")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "write_docx")!.defaultPermission).toBe("hitl");
  });
});

// ─── Word read/write roundtrip ───────────────────────────────────────

describe("Word roundtrip", () => {
  const getWriteTool = () => createWordToolEntries().find(e => e.name === "write_docx")!;
  const getReadTool = () => createWordToolEntries().find(e => e.name === "read_docx")!;

  const docxPath = join(testDir, "test.docx");

  test("write_docx creates a file", async () => {
    const tool = getWriteTool();
    const raw = await tool.execute("tc9", {
      filePath: docxPath,
      content: [
        { type: "heading", text: "Test Document", level: 1 },
        { type: "paragraph", text: "This is a test paragraph." },
        { type: "bullet", text: "Item one" },
        { type: "bullet", text: "Item two" },
        { type: "paragraph", text: "Bold text here", bold: true },
      ],
    });
    const text = extractText(raw);
    expect(text).toContain("Word file written");
    expect(text).toContain("5 blocks");
  });

  test("read_docx extracts text", async () => {
    const tool = getReadTool();
    const raw = await tool.execute("tc10", { filePath: docxPath, format: "text" });
    const text = extractText(raw);
    expect(text).toContain("Test Document");
    expect(text).toContain("test paragraph");
    expect(text).toContain("Item one");
    expect(text).toContain("Bold text here");
  });

  test("read_docx returns error for non-existent file", async () => {
    const tool = getReadTool();
    const raw = await tool.execute("tc11", { filePath: join(testDir, "nope.docx") });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });
});
