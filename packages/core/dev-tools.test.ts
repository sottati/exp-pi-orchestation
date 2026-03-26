import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createDevToolEntries } from "./dev-tools";

const TEST_DIR = join(import.meta.dir, "__test_dev_tools__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "hello.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function getTool(name: string) {
  const tools = createDevToolEntries({ basePath: TEST_DIR, commandWhitelist: ["bun test", "bun run"] });
  return tools.find(t => t.name === name)!;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return (first as { text: string }).text;
}

// --- read_file ---
test("read_file reads a file with line numbers", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t1", { filePath: join(TEST_DIR, "hello.ts") });
  expect(getText(result)).toContain("1: const x = 1;");
  expect(getText(result)).toContain("3: const z = 3;");
});

test("read_file respects startLine/endLine", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t2", { filePath: join(TEST_DIR, "hello.ts"), startLine: 2, endLine: 2 });
  expect(getText(result)).toBe("2: const y = 2;");
});

test("read_file rejects path outside basePath", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t3", { filePath: "/etc/passwd" });
  expect(getText(result)).toContain("outside the allowed base path");
});

// --- write_file ---
test("write_file creates a new file", async () => {
  const tool = getTool("write_file");
  const target = join(TEST_DIR, "new.ts");
  const result = await tool.execute("t4", { filePath: target, content: "hello world" });
  expect(getText(result)).toContain("bytes");
  expect(readFileSync(target, "utf-8")).toBe("hello world");
});

test("write_file creates parent dirs when createDirs is true", async () => {
  const tool = getTool("write_file");
  const target = join(TEST_DIR, "sub", "deep", "file.ts");
  await tool.execute("t5", { filePath: target, content: "nested", createDirs: true });
  expect(readFileSync(target, "utf-8")).toBe("nested");
});

test("write_file rejects path outside basePath", async () => {
  const tool = getTool("write_file");
  const result = await tool.execute("t6", { filePath: "/tmp/__evil__.ts", content: "bad" });
  expect(getText(result)).toContain("outside the allowed base path");
});

// --- edit_file ---
test("edit_file replaces text in a file", async () => {
  const tool = getTool("edit_file");
  const result = await tool.execute("t7", {
    filePath: join(TEST_DIR, "hello.ts"),
    oldText: "const y = 2;",
    newText: "const y = 42;",
  });
  expect(getText(result)).toContain("replaced");
  expect(readFileSync(join(TEST_DIR, "hello.ts"), "utf-8")).toContain("const y = 42;");
});

test("edit_file fails when oldText not found", async () => {
  const tool = getTool("edit_file");
  const result = await tool.execute("t8", {
    filePath: join(TEST_DIR, "hello.ts"),
    oldText: "not here",
    newText: "whatever",
  });
  expect(getText(result)).toContain("not found");
});

test("edit_file fails when oldText is ambiguous (multiple matches)", async () => {
  writeFileSync(join(TEST_DIR, "dup.ts"), "const a = 1;\nconst a = 1;\n");
  const tool = getTool("edit_file");
  const result = await tool.execute("t9", {
    filePath: join(TEST_DIR, "dup.ts"),
    oldText: "const a = 1;",
    newText: "const a = 99;",
  });
  expect(getText(result)).toContain("ambiguous");
});

test("edit_file replaceAll replaces all occurrences", async () => {
  writeFileSync(join(TEST_DIR, "dup.ts"), "const a = 1;\nconst a = 1;\n");
  const tool = getTool("edit_file");
  await tool.execute("t10", {
    filePath: join(TEST_DIR, "dup.ts"),
    oldText: "const a = 1;",
    newText: "const a = 99;",
    replaceAll: true,
  });
  const content = readFileSync(join(TEST_DIR, "dup.ts"), "utf-8");
  expect(content).toBe("const a = 99;\nconst a = 99;\n");
});

// --- run_command ---
test("run_command executes whitelisted command", async () => {
  const tool = getTool("run_command");
  const result = await tool.execute("t11", { command: "bun test --help" });
  const text = getText(result);
  const parsed = JSON.parse(text);
  expect(parsed.exitCode).toBeDefined();
});

test("run_command rejects non-whitelisted command", async () => {
  const tool = getTool("run_command");
  const result = await tool.execute("t12", { command: "rm -rf /" });
  expect(getText(result)).toContain("not allowed");
});

test("run_command rejects shell metacharacters", async () => {
  const tool = getTool("run_command");
  const result = await tool.execute("t13", { command: "bun test && rm -rf /" });
  expect(getText(result)).toContain("metacharacter");
});

// --- list_directory ---
test("list_directory lists files", async () => {
  const tool = getTool("list_directory");
  const result = await tool.execute("t14", { directory: TEST_DIR });
  expect(getText(result)).toContain("hello.ts");
});

// --- search_code ---
test("search_code finds pattern", async () => {
  const tool = getTool("search_code");
  const result = await tool.execute("t15", { pattern: "const y", directory: TEST_DIR });
  expect(getText(result)).toContain("const y = 2;");
});

// --- tool count ---
test("createDevToolEntries returns 6 tools", () => {
  const tools = createDevToolEntries({ commandWhitelist: [] });
  expect(tools.length).toBe(6);
  const names = tools.map(t => t.name).sort();
  expect(names).toEqual(["edit_file", "list_directory", "read_file", "run_command", "search_code", "write_file"]);
});
