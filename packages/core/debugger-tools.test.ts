import { test, expect, describe, afterAll } from "bun:test";
import { createDebuggerToolEntries } from "./debugger-tools";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

function extractText(result: any): string {
  return result.content[0].text;
}

const testDir = join(tmpdir(), `debugger-test-${Date.now()}`);
mkdirSync(join(testDir, "src", "utils"), { recursive: true });
mkdirSync(join(testDir, "lib"), { recursive: true });

// Create test files
writeFileSync(join(testDir, "src", "index.ts"), [
  'import { helper } from "./utils/helper";',
  "",
  "export function main() {",
  "  const result = helper();",
  '  console.log("done", result);',
  "}",
].join("\n"));

writeFileSync(join(testDir, "src", "utils", "helper.ts"), [
  "export function helper(): string {",
  '  return "hello";',
  "}",
  "",
  "export function buggyFunction() {",
  "  // TODO: fix this",
  "  throw new Error('not implemented');",
  "}",
].join("\n"));

writeFileSync(join(testDir, "lib", "data.json"), '{"key": "value"}');

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("createDebuggerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createDebuggerToolEntries();
    const names = entries.map(e => e.name);
    expect(names).toEqual(["read_file", "search_code", "list_directory"]);
  });

  test("read_file and search_code have hitl permission", () => {
    const entries = createDebuggerToolEntries();
    expect(entries.find(e => e.name === "read_file")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "search_code")!.defaultPermission).toBe("hitl");
  });

  test("list_directory has allow permission", () => {
    const entries = createDebuggerToolEntries();
    expect(entries.find(e => e.name === "list_directory")!.defaultPermission).toBe("allow");
  });

  test("all tools have source local and are available", () => {
    const entries = createDebuggerToolEntries();
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });

  test("all tools have description and execute function", () => {
    const entries = createDebuggerToolEntries();
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });
});

describe("read_file", () => {
  const getTool = () => createDebuggerToolEntries().find(e => e.name === "read_file")!;

  test("reads a file with line numbers", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc1", { filePath: join(testDir, "src", "index.ts") });
    const text = extractText(raw);
    expect(text).toContain("1: import");
    expect(text).toContain("3: export function main()");
    expect(raw.details.totalLines).toBe(6);
  });

  test("reads a range of lines", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc2", {
      filePath: join(testDir, "src", "index.ts"),
      startLine: 3,
      endLine: 4,
    });
    const text = extractText(raw);
    expect(text).toContain("3: export function main()");
    expect(text).toContain("4:");
    expect(text).not.toContain("1: import");
    expect(raw.details.linesReturned).toBe(2);
  });

  test("returns error for non-existent file", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc3", { filePath: join(testDir, "nonexistent.ts") });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });

  test("rejects path outside basePath", async () => {
    const entries = createDebuggerToolEntries({ basePath: join(testDir, "src") });
    const tool = entries.find(e => e.name === "read_file")!;
    const raw = await tool.execute("tc4", { filePath: join(testDir, "lib", "data.json") });
    const text = extractText(raw);
    expect(text).toContain("outside the allowed base path");
  });

  test("rejects files exceeding size limit", async () => {
    const entries = createDebuggerToolEntries({ maxFileSize: 10 }); // 10 bytes
    const tool = entries.find(e => e.name === "read_file")!;
    const raw = await tool.execute("tc5", { filePath: join(testDir, "src", "index.ts") });
    const text = extractText(raw);
    expect(text).toContain("File too large");
  });
});

describe("search_code", () => {
  const getTool = () => createDebuggerToolEntries().find(e => e.name === "search_code")!;

  test("finds pattern in files", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc6", { pattern: "helper", directory: testDir });
    const result = JSON.parse(extractText(raw));
    expect(result.matchCount).toBeGreaterThan(0);
    const files = result.matches.map((m: any) => m.file);
    expect(files.some((f: string) => f.includes("index.ts"))).toBe(true);
    expect(files.some((f: string) => f.includes("helper.ts"))).toBe(true);
  });

  test("search is case-insensitive", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc7", { pattern: "HELPER", directory: testDir });
    const result = JSON.parse(extractText(raw));
    expect(result.matchCount).toBeGreaterThan(0);
  });

  test("filters by file extension", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc8", {
      pattern: "key",
      directory: testDir,
      fileExtensions: [".json"],
    });
    const result = JSON.parse(extractText(raw));
    expect(result.matchCount).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.file).toContain(".json");
    }
  });

  test("returns empty when no matches", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc9", { pattern: "zzzznonexistent", directory: testDir });
    const result = JSON.parse(extractText(raw));
    expect(result.matchCount).toBe(0);
  });

  test("respects maxSearchResults", async () => {
    const entries = createDebuggerToolEntries({ maxSearchResults: 2 });
    const tool = entries.find(e => e.name === "search_code")!;
    const raw = await tool.execute("tc10", { pattern: "e", directory: testDir }); // 'e' matches many lines
    const result = JSON.parse(extractText(raw));
    expect(result.matches.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  test("returns error for non-existent directory", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc11", { pattern: "x", directory: join(testDir, "nope") });
    const result = JSON.parse(extractText(raw));
    expect(result.matchCount).toBe(0);
  });
});

describe("list_directory", () => {
  const getTool = () => createDebuggerToolEntries().find(e => e.name === "list_directory")!;

  test("lists files and directories", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc12", { directory: testDir });
    const result = JSON.parse(extractText(raw));
    const paths = result.items.map((i: any) => i.path);
    expect(paths.some((p: string) => p.includes("src"))).toBe(true);
    expect(paths.some((p: string) => p.includes("lib"))).toBe(true);
  });

  test("shows file sizes", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc13", { directory: join(testDir, "lib") });
    const result = JSON.parse(extractText(raw));
    const jsonFile = result.items.find((i: any) => i.path.includes("data.json"));
    expect(jsonFile).toBeTruthy();
    expect(jsonFile.type).toBe("file");
    expect(jsonFile.size).toBeGreaterThan(0);
  });

  test("lists recursively with depth limit", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc14", { directory: testDir, recursive: true });
    const result = JSON.parse(extractText(raw));
    const paths = result.items.map((i: any) => i.path);
    expect(paths.some((p: string) => p.includes("helper.ts"))).toBe(true);
  });

  test("returns error for non-existent directory", async () => {
    const tool = getTool();
    const raw = await tool.execute("tc15", { directory: join(testDir, "nope") });
    const result = JSON.parse(extractText(raw));
    expect(result.itemCount).toBe(0);
  });
});
