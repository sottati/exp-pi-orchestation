# Web Designer Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a `web-designer` frontend specialist agent with shared dev tools, frontend-specific tools (preview, responsive, a11y), and bidirectional delegation with the `code` agent.

**Architecture:** Two new modules (`dev-tools.ts`, `frontend-tools.ts`) provide tool entries. The `web-designer` agent definition uses both plus a shared `browse_url`. The `code` agent is upgraded with dev tools and bidirectional delegation. MCP integrations are optional and deferred.

**Tech Stack:** TypeScript, Bun, `@sinclair/typebox` (schemas), Playwright (browser), `axe-core` (a11y), existing `pi-agent-core` / `pi-ai` runtime.

**Spec:** `docs/superpowers/specs/2026-03-26-web-designer-agent-design.md`

---

### Task 0: Install `axe-core` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install axe-core**

Run: `bun add axe-core`

**Step 2: Verify installation**

Run: `ls node_modules/axe-core/axe.min.js`
Expected: File exists

**Step 3: Commit**

```bash
git add package.json bun.lock*
git commit -m "chore: add axe-core dependency for a11y validation"
```

---

### Task 1: Create `dev-tools.ts` — shared development tools

**Files:**
- Create: `packages/core/dev-tools.ts`
- Reference: `packages/core/debugger-tools.ts` (copy read-only tool logic with identical parameter names)
- Reference: `packages/core/tool-registry.ts` (ToolEntry interface)

**Step 1: Write the test file**

Create `packages/core/dev-tools.test.ts`:

```ts
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

// --- read_file ---
test("read_file reads a file with line numbers", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t1", { filePath: join(TEST_DIR, "hello.ts") });
  expect(result.content[0].text).toContain("1: const x = 1;");
  expect(result.content[0].text).toContain("3: const z = 3;");
});

test("read_file respects startLine/endLine", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t2", { filePath: join(TEST_DIR, "hello.ts"), startLine: 2, endLine: 2 });
  expect(result.content[0].text).toBe("2: const y = 2;");
});

test("read_file rejects path outside basePath", async () => {
  const tool = getTool("read_file");
  const result = await tool.execute("t3", { filePath: "/etc/passwd" });
  expect(result.content[0].text).toContain("outside the allowed base path");
});

// --- write_file ---
test("write_file creates a new file", async () => {
  const tool = getTool("write_file");
  const target = join(TEST_DIR, "new.ts");
  const result = await tool.execute("t4", { filePath: target, content: "hello world" });
  expect(result.content[0].text).toContain("bytes");
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
  expect(result.content[0].text).toContain("outside the allowed base path");
});

// --- edit_file ---
test("edit_file replaces text in a file", async () => {
  const tool = getTool("edit_file");
  const result = await tool.execute("t7", {
    filePath: join(TEST_DIR, "hello.ts"),
    oldText: "const y = 2;",
    newText: "const y = 42;",
  });
  expect(result.content[0].text).toContain("replaced");
  expect(readFileSync(join(TEST_DIR, "hello.ts"), "utf-8")).toContain("const y = 42;");
});

test("edit_file fails when oldText not found", async () => {
  const tool = getTool("edit_file");
  const result = await tool.execute("t8", {
    filePath: join(TEST_DIR, "hello.ts"),
    oldText: "not here",
    newText: "whatever",
  });
  expect(result.content[0].text).toContain("not found");
});

test("edit_file fails when oldText is ambiguous (multiple matches)", async () => {
  writeFileSync(join(TEST_DIR, "dup.ts"), "const a = 1;\nconst a = 1;\n");
  const tool = getTool("edit_file");
  const result = await tool.execute("t9", {
    filePath: join(TEST_DIR, "dup.ts"),
    oldText: "const a = 1;",
    newText: "const a = 99;",
  });
  expect(result.content[0].text).toContain("ambiguous");
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
  const text = result.content[0].text;
  const parsed = JSON.parse(text);
  expect(parsed.exitCode).toBeDefined();
});

test("run_command rejects non-whitelisted command", async () => {
  const tool = getTool("run_command");
  const result = await tool.execute("t12", { command: "rm -rf /" });
  expect(result.content[0].text).toContain("not allowed");
});

test("run_command rejects shell metacharacters", async () => {
  const tool = getTool("run_command");
  const result = await tool.execute("t13", { command: "bun test && rm -rf /" });
  expect(result.content[0].text).toContain("metacharacter");
});

// --- list_directory ---
test("list_directory lists files", async () => {
  const tool = getTool("list_directory");
  const result = await tool.execute("t14", { directory: TEST_DIR });
  expect(result.content[0].text).toContain("hello.ts");
});

// --- search_code ---
test("search_code finds pattern", async () => {
  const tool = getTool("search_code");
  const result = await tool.execute("t15", { pattern: "const y", directory: TEST_DIR });
  expect(result.content[0].text).toContain("const y = 2;");
});

// --- tool count ---
test("createDevToolEntries returns 6 tools", () => {
  const tools = createDevToolEntries({ commandWhitelist: [] });
  expect(tools.length).toBe(6);
  const names = tools.map(t => t.name).sort();
  expect(names).toEqual(["edit_file", "list_directory", "read_file", "run_command", "search_code", "write_file"]);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/dev-tools.test.ts`
Expected: FAIL — `Cannot find module "./dev-tools"`

**Step 3: Implement `dev-tools.ts`**

Create `packages/core/dev-tools.ts`:

```ts
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import { readdirSync, readFileSync, statSync, mkdirSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";

export interface DevToolOptions {
  maxFileSize?: number;
  maxSearchResults?: number;
  basePath?: string;
  commandWhitelist?: string[];
}

const DEFAULT_MAX_FILE_SIZE = 512 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 50;
const SKIP_DIRS = new Set(["node_modules", ".git", ".runtime-data", "dist", "build"]);
const SHELL_METACHAR_RE = /[;&|`]|\$\(|\)\s*\|/;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function isPathSafe(filePath: string, basePath?: string): boolean {
  if (!basePath) return true;
  const resolved = resolve(filePath);
  return resolved.startsWith(resolve(basePath));
}

function isCommandAllowed(command: string, whitelist?: string[]): boolean {
  if (!whitelist || whitelist.length === 0) return false;
  const tokens = command.trim().split(/\s+/);
  return whitelist.some(prefix => {
    const prefixTokens = prefix.split(/\s+/);
    if (tokens.length < prefixTokens.length) return false;
    return prefixTokens.every((pt, i) => tokens[i] === pt);
  });
}

export function createDevToolEntries(opts?: DevToolOptions): ToolEntry[] {
  const maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxSearchResults = opts?.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const basePath = opts?.basePath;
  const commandWhitelist = opts?.commandWhitelist;

  const readFile: ToolEntry = {
    name: "read_file",
    source: "local",
    description: "Read the contents of a source file. Returns the file text with line numbers.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file to read" }),
      startLine: Type.Optional(Type.Number({ description: "Start reading from this line (1-based, default: 1)" })),
      endLine: Type.Optional(Type.Number({ description: "Stop reading at this line (inclusive)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const startLine = (params.startLine as number | undefined) ?? 1;
      const endLine = params.endLine as number | undefined;

      if (!isPathSafe(filePath, basePath)) {
        return textResult(`Error: Path "${filePath}" is outside the allowed base path.`);
      }

      try {
        const file = Bun.file(filePath);
        const size = file.size;
        if (size > maxFileSize) {
          return textResult(
            `Error: File too large: ${(size / 1024).toFixed(1)}KB exceeds ${(maxFileSize / 1024).toFixed(0)}KB limit. Use startLine/endLine to read a section.`,
          );
        }

        const text = await file.text();
        const allLines = text.split(/\r?\n/);
        const start = Math.max(1, startLine);
        const end = endLine ? Math.min(endLine, allLines.length) : allLines.length;
        const selectedLines = allLines.slice(start - 1, end);

        const numbered = selectedLines.map((line, i) => `${start + i}: ${line}`).join("\n");
        return textResult(numbered, { filePath, totalLines: allLines.length, startLine: start, endLine: end, linesReturned: selectedLines.length });
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const searchCode: ToolEntry = {
    name: "search_code",
    source: "local",
    description: "Search for a text pattern across files in a directory. Returns matching lines with file paths and line numbers.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text pattern to search for (case-insensitive substring match)" }),
      directory: Type.String({ description: "Directory to search in" }),
      fileExtensions: Type.Optional(Type.Array(Type.String(), { description: "File extensions to include (e.g. ['.ts', '.js']). Default: all text files." })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const pattern = params.pattern as string;
      const directory = params.directory as string;
      const extensions = params.fileExtensions as string[] | undefined;

      if (!isPathSafe(directory, basePath)) {
        return textResult(`Error: Directory "${directory}" is outside the allowed base path.`);
      }

      try {
        const matches: { file: string; line: number; text: string }[] = [];
        const lowerPattern = pattern.toLowerCase();

        function walkDir(dir: string): void {
          if (matches.length >= maxSearchResults) return;
          let names: string[];
          try { names = readdirSync(dir) as unknown as string[]; } catch { return; }

          for (const name of names) {
            if (matches.length >= maxSearchResults) return;
            const fullPath = join(dir, name);
            let stat;
            try { stat = statSync(fullPath); } catch { continue; }

            if (stat.isDirectory()) {
              if (SKIP_DIRS.has(name)) continue;
              walkDir(fullPath);
              continue;
            }
            if (!stat.isFile()) continue;
            if (extensions && extensions.length > 0 && !extensions.some(ext => name.endsWith(ext))) continue;
            if (stat.size > maxFileSize) continue;

            try {
              const content = readFileSync(fullPath, "utf-8");
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= maxSearchResults) break;
                if (lines[i]!.toLowerCase().includes(lowerPattern)) {
                  matches.push({ file: fullPath, line: i + 1, text: lines[i]!.trim() });
                }
              }
            } catch { /* skip unreadable */ }
          }
        }

        walkDir(directory);
        const truncated = matches.length >= maxSearchResults;
        const resultData = { pattern, directory, matchCount: matches.length, truncated, maxSearchResults, matches };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const listDirectory: ToolEntry = {
    name: "list_directory",
    source: "local",
    description: "List files and subdirectories in a directory. Returns names, types, and sizes.",
    parameters: Type.Object({
      directory: Type.String({ description: "Path to the directory to list" }),
      recursive: Type.Optional(Type.Boolean({ description: "List recursively (default: false, max depth 3)" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const directory = params.directory as string;
      const recursive = (params.recursive as boolean) ?? false;

      if (!isPathSafe(directory, basePath)) {
        return textResult(`Error: Directory "${directory}" is outside the allowed base path.`);
      }

      try {
        const items: { path: string; type: string; size?: number }[] = [];

        function listDir(dir: string, depth: number): void {
          let names: string[];
          try { names = readdirSync(dir) as unknown as string[]; } catch { return; }
          for (const name of names) {
            const fullPath = join(dir, name);
            let stat;
            try { stat = statSync(fullPath); } catch { continue; }
            if (stat.isDirectory()) {
              if (SKIP_DIRS.has(name)) continue;
              items.push({ path: fullPath, type: "directory" });
              if (recursive && depth < 3) listDir(fullPath, depth + 1);
            } else if (stat.isFile()) {
              items.push({ path: fullPath, type: "file", size: stat.size });
            }
          }
        }

        listDir(directory, 0);
        const resultData = { directory, recursive, itemCount: items.length, items };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const writeFile: ToolEntry = {
    name: "write_file",
    source: "local",
    description: "Create or overwrite a file with the given content.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file to write" }),
      content: Type.String({ description: "File content to write" }),
      createDirs: Type.Optional(Type.Boolean({ description: "Create parent directories if they don't exist (default: false)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const content = params.content as string;
      const createDirs = (params.createDirs as boolean) ?? false;

      if (!isPathSafe(filePath, basePath)) {
        return textResult(`Error: Path "${filePath}" is outside the allowed base path.`);
      }

      try {
        if (createDirs) {
          const dir = dirname(filePath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }
        await Bun.write(filePath, content);
        const bytes = Buffer.byteLength(content, "utf-8");
        return textResult(`Written ${bytes} bytes to ${filePath}`, { filePath, bytes });
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const editFile: ToolEntry = {
    name: "edit_file",
    source: "local",
    description: "Edit a file by replacing a text occurrence. Fails if the text is not found or is ambiguous (multiple matches without replaceAll).",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file to edit" }),
      oldText: Type.String({ description: "Text to find and replace" }),
      newText: Type.String({ description: "Replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: false, single match only)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const filePath = params.filePath as string;
      const oldText = params.oldText as string;
      const newText = params.newText as string;
      const replaceAll = (params.replaceAll as boolean) ?? false;

      if (!isPathSafe(filePath, basePath)) {
        return textResult(`Error: Path "${filePath}" is outside the allowed base path.`);
      }

      try {
        const file = Bun.file(filePath);
        const content = await file.text();

        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) {
          return textResult(`Error: Text not found in ${filePath}.`);
        }
        if (occurrences > 1 && !replaceAll) {
          return textResult(`Error: Text is ambiguous — found ${occurrences} occurrences in ${filePath}. Use replaceAll: true to replace all.`);
        }

        const updated = replaceAll
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);
        await Bun.write(filePath, updated);
        return textResult(`Successfully replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}.`, { filePath, occurrences: replaceAll ? occurrences : 1 });
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const runCommand: ToolEntry = {
    name: "run_command",
    source: "local",
    description: "Execute a whitelisted shell command. Returns stdout, stderr, and exit code.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: process.cwd())" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 30000, max: 120000)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const command = params.command as string;
      const cwd = (params.cwd as string | undefined) ?? process.cwd();
      const timeout = Math.min((params.timeout as number | undefined) ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

      if (SHELL_METACHAR_RE.test(command)) {
        return textResult(`Error: Command contains shell metacharacter(s) and is rejected for security.`);
      }
      if (!isCommandAllowed(command, commandWhitelist)) {
        return textResult(`Error: Command "${command}" is not allowed. Allowed prefixes: ${(commandWhitelist ?? []).join(", ")}`);
      }

      try {
        const start = Date.now();
        const tokens = command.trim().split(/\s+/);
        const proc = Bun.spawn(tokens, { cwd, stdout: "pipe", stderr: "pipe" });

        const timer = setTimeout(() => proc.kill(), timeout);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        const resultData = { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000), exitCode, durationMs };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [readFile, searchCode, listDirectory, writeFile, editFile, runCommand];
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/core/dev-tools.test.ts`
Expected: All 16 tests PASS

**Step 5: Commit**

```bash
git add packages/core/dev-tools.ts packages/core/dev-tools.test.ts
git commit -m "feat: add shared dev-tools (read/write/edit/search/list/run)"
```

---

### Task 2: Create `frontend-tools.ts` — preview, responsive, a11y

**Files:**
- Create: `packages/core/frontend-tools.ts`
- Reference: `packages/core/browser.ts` (`safeLaunchAndRun`, `truncateContent`)

**Step 1: Write the test file**

Create `packages/core/frontend-tools.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createFrontendToolEntries } from "./frontend-tools";

test("createFrontendToolEntries returns 3 tools", () => {
  const tools = createFrontendToolEntries();
  expect(tools.length).toBe(3);
  const names = tools.map(t => t.name).sort();
  expect(names).toEqual(["check_responsive", "preview_page", "validate_accessibility"]);
});

test("all frontend tools have allow permission", () => {
  const tools = createFrontendToolEntries();
  for (const t of tools) {
    expect(t.defaultPermission).toBe("allow");
  }
});

test("all frontend tools are available", () => {
  const tools = createFrontendToolEntries();
  for (const t of tools) {
    expect(t.available).toBe(true);
  }
});

// Note: Full browser-based tests require Playwright chromium.
// These are covered by smoke:web-designer integration test.
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/frontend-tools.test.ts`
Expected: FAIL — `Cannot find module "./frontend-tools"`

**Step 3: Implement `frontend-tools.ts`**

Create `packages/core/frontend-tools.ts`:

```ts
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import { safeLaunchAndRun, truncateContent } from "./browser";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const SCREENSHOTS_DIR = ".runtime-data/screenshots";
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

function ensureScreenshotDir(): string {
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  return SCREENSHOTS_DIR;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createFrontendToolEntries(): ToolEntry[] {
  const previewPage: ToolEntry = {
    name: "preview_page",
    source: "local",
    description: "Navigate to a URL, extract readable content, and save a screenshot. Returns text content (for LLM) and screenshot path (for human review).",
    parameters: Type.Object({
      url: Type.String({ description: "URL to preview (typically localhost dev server)" }),
      viewport: Type.Optional(Type.Object({
        width: Type.Number({ description: "Viewport width (default: 1280)" }),
        height: Type.Number({ description: "Viewport height (default: 720)" }),
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const viewport = (params.viewport as { width: number; height: number } | undefined) ?? DEFAULT_VIEWPORT;

      try {
        return await safeLaunchAndRun(async (page) => {
          await page.setViewportSize(viewport);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

          const title = await page.title();
          const content = await page.evaluate(() => {
            const selectors = ["nav", "header", "footer", "[role=navigation]", "[role=banner]", ".ad", ".ads"];
            for (const sel of selectors) {
              document.querySelectorAll(sel).forEach(el => el.remove());
            }
            return document.body?.innerText ?? "";
          });

          const dir = ensureScreenshotDir();
          const screenshotPath = join(dir, `preview-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });

          const resultData = {
            title,
            url: page.url(),
            viewport,
            screenshotPath,
          };
          return textResult(
            `# ${title}\nURL: ${page.url()}\nViewport: ${viewport.width}x${viewport.height}\nScreenshot: ${screenshotPath}\n\n${truncateContent(content)}`,
            resultData,
          );
        });
      } catch (err) {
        return textResult(`Error previewing ${url}: ${errorMessage(err)}`);
      }
    },
  };

  const checkResponsive: ToolEntry = {
    name: "check_responsive",
    source: "local",
    description: "Load a page at multiple viewports and compare content/layout metrics. Screenshots saved for human review; LLM receives text + metrics.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to check" }),
      viewports: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String(),
          width: Type.Number(),
          height: Type.Number(),
        }),
        { description: "Viewports to test. Defaults: mobile (375x667), tablet (768x1024), desktop (1440x900)." },
      )),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const viewports = (params.viewports as Array<{ name: string; width: number; height: number }> | undefined) ?? DEFAULT_VIEWPORTS;

      try {
        return await safeLaunchAndRun(async (page) => {
          const results: Array<{
            name: string;
            viewport: { width: number; height: number };
            content: string;
            metrics: { scrollHeight: number; elementCount: number };
            screenshotPath: string;
          }> = [];

          for (const vp of viewports) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

            const { content, scrollHeight, elementCount } = await page.evaluate(() => {
              return {
                content: document.body?.innerText ?? "",
                scrollHeight: document.documentElement.scrollHeight,
                elementCount: document.querySelectorAll("*").length,
              };
            });

            const dir = ensureScreenshotDir();
            const screenshotPath = join(dir, `responsive-${vp.name}-${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });

            results.push({
              name: vp.name,
              viewport: { width: vp.width, height: vp.height },
              content: truncateContent(content, 2000),
              metrics: { scrollHeight, elementCount },
              screenshotPath,
            });
          }

          const summary = results.map(r =>
            `## ${r.name} (${r.viewport.width}x${r.viewport.height})\nScroll height: ${r.metrics.scrollHeight}px | Elements: ${r.metrics.elementCount}\nScreenshot: ${r.screenshotPath}\n\n${r.content}`,
          ).join("\n\n---\n\n");

          return textResult(summary, { results: results.map(r => ({ ...r, content: undefined })) });
        });
      } catch (err) {
        return textResult(`Error checking responsive for ${url}: ${errorMessage(err)}`);
      }
    },
  };

  const validateAccessibility: ToolEntry = {
    name: "validate_accessibility",
    source: "local",
    description: "Run axe-core accessibility audit on a page. Returns violations grouped by severity.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to validate" }),
      standard: Type.Optional(Type.Union([
        Type.Literal("wcag2a"),
        Type.Literal("wcag2aa"),
      ], { description: "Accessibility standard (default: wcag2aa)" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const standard = (params.standard as "wcag2a" | "wcag2aa" | undefined) ?? "wcag2aa";

      try {
        const axeSource = await Bun.file(
          join(import.meta.dir, "../../node_modules/axe-core/axe.min.js"),
        ).text();

        return await safeLaunchAndRun(async (page) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.evaluate(axeSource);

          const axeResult = await page.evaluate((std: string) => {
            const tags = std === "wcag2a"
              ? ["wcag2a"]
              : ["wcag2a", "wcag2aa"];
            // @ts-ignore - axe is injected
            return (window as any).axe.run(document, { runOnly: { type: "tag", values: tags } });
          }, standard);

          const violations = (axeResult as any).violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            nodes: v.nodes.length,
          }));
          const passes = (axeResult as any).passes.length;
          const total = violations.length + passes;

          const summary = violations.length === 0
            ? `Accessibility check passed (${standard}): ${passes} rules passed, 0 violations.`
            : `Accessibility violations (${standard}): ${violations.length} issues found.\n\n` +
              violations.map((v: any) => `- [${v.impact}] ${v.id}: ${v.description} (${v.nodes} elements)`).join("\n");

          return textResult(summary, { violations, passes, total, standard });
        });
      } catch (err) {
        return textResult(`Error validating accessibility for ${url}: ${errorMessage(err)}`);
      }
    },
  };

  return [previewPage, checkResponsive, validateAccessibility];
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/core/frontend-tools.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add packages/core/frontend-tools.ts packages/core/frontend-tools.test.ts
git commit -m "feat: add frontend-tools (preview, responsive, a11y)"
```

---

### Task 3: Add `web-designer` agent and update `code` agent

**Files:**
- Modify: `packages/core/agents.ts:1-294`

**Step 1: Add imports at top of agents.ts**

After existing imports (line 13), add:

```ts
import { createDevToolEntries } from "./dev-tools";
import { createFrontendToolEntries } from "./frontend-tools";
```

**Step 2: Update the `code` agent definition**

Replace lines 42-51 (the `code` agent) with:

```ts
  const code = defineAgent("code")
    .name("Code Specialist")
    .role("Creates, edits, and debugs backend code.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a coding specialist. Return concise, practical answers. "
      + "You can read, write, and edit files in the project. You can run build and "
      + "test commands. When you need frontend work, delegate to the web-designer."
    )
    .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
    .localToolEntries([
      ...createDevToolEntries({
        commandWhitelist: ["bun build", "bun test", "bun run", "bunx tsc"],
      }),
    ])
    .permissions({
      "read_file": "hitl",
      "write_file": "hitl",
      "edit_file": "hitl",
      "run_command": "hitl",
      "search_code": "hitl",
    })
    .canDelegateTo(["web-designer"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();
```

**Step 3: Add `web-designer` agent definition**

Before the `return` statement (line 294), add:

```ts
  const explorerToolsForDesigner = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const browseUrlEntry = explorerToolsForDesigner.filter(t => t.name === "browse_url");

  const webDesigner = defineAgent("web-designer")
    .name("Web Designer & Frontend Dev")
    .role("Designs and builds frontend interfaces — HTML, CSS, React/TSX, Tailwind. "
      + "Reads/writes project files, previews in browser, validates accessibility. "
      + "Knows React, Next.js, Astro, shadcn, design systems.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt("You are a frontend specialist. You build UI components, pages, "
      + "and layouts. You write clean, accessible, responsive code. You read existing "
      + "code to understand patterns before making changes. You preview your work in "
      + "the browser and validate accessibility. When you need backend endpoints, "
      + "delegate to the code specialist.")
    .capabilities([
      "html", "css", "tailwind", "react", "tsx",
      "responsive-design", "accessibility", "design-systems",
      "component-architecture", "preview", "prototyping",
      "nextjs", "astro", "shadcn",
    ])
    .localToolEntries([
      ...createDevToolEntries({
        commandWhitelist: ["bun build", "bun test", "bunx tailwindcss",
          "bunx eslint", "bunx prettier", "bun run"],
      }),
      ...createFrontendToolEntries(),
      ...browseUrlEntry,
    ])
    .permissions({
      "read_file": "hitl",
      "write_file": "hitl",
      "edit_file": "hitl",
      "run_command": "hitl",
      "search_code": "hitl",
    })
    .canDelegateTo(["code"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();
```

**Step 4: Update orchestrator system prompt**

In the orchestrator's `.systemPrompt(...)` array (around line 24-36), add before the "After tool results..." line:

```ts
"The web-designer specialist builds frontend interfaces (HTML, CSS, React, Tailwind), previews pages, and validates accessibility.",
```

**Step 5: Update the return array**

Change line 294:

```ts
  return [orchestrator, code, math, explorer, writer, debugger_, secretary, webDesigner];
```

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 7: Commit**

```bash
git add packages/core/agents.ts
git commit -m "feat: add web-designer agent, upgrade code agent with dev tools"
```

---

### Task 4: Add `web-designer` to UI (AGENT_PERSONALITIES)

**Files:**
- Modify: `apps/web/types.ts:90-98`

**Step 1: Add web-designer personality**

After the `secretary` line (line 97), add:

```ts
  "web-designer": { accent: "#ff5555", badge: "F", tagline: "pixels with purpose" },
```

**Step 2: Commit**

```bash
git add apps/web/types.ts
git commit -m "feat: add web-designer to UI agent personalities"
```

---

### Task 5: Add smoke test script

**Files:**
- Modify: `package.json`

**Step 1: Add smoke:web-designer script**

In the `"scripts"` section of `package.json`, add after `"smoke:debugger"`:

```json
"smoke:web-designer": "bun run apps/cli/index.ts --smoke web-designer"
```

**Step 2: Verify it runs**

Run: `bun run smoke:web-designer`
Expected: Agent initializes and responds (may fail on actual task if no API key, but should not crash on startup)

**Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add smoke:web-designer script"
```

---

### Task 6: Update documentation (CLAUDE.md, README.md, AGENTS.md)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Step 1: Update CLAUDE.md**

In the `## Project Context` section, add to the file list:

```
- Dev tools: `packages/core/dev-tools.ts` (`read_file`, `write_file`, `edit_file`, `search_code`, `list_directory`, `run_command` — shared by `code` and `web-designer`)
- Frontend tools: `packages/core/frontend-tools.ts` (`preview_page`, `check_responsive`, `validate_accessibility` — assigned to `web-designer`)
```

In the `## Model Configuration` section, add:

```
- `web-designer` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: dev tools + frontend tools + `browse_url`)
```

Update the `code` entry to mention dev tools:

```
- `code` → `openrouter/google/gemini-3.1-flash-lite-preview` (tools: dev tools)
```

In the `## Operational Runbook` section, add:

```
- `bun run smoke:web-designer`
```

**Step 2: Update AGENTS.md**

Add a `web-designer` section describing the agent, its role, tools, and capabilities. Update the `code` section to reflect dev tools.

**Step 3: Update README.md**

Add `web-designer` to the agents list and tool summary.

**Step 4: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "docs: add web-designer agent to project documentation"
```

---

### Task 7: Run full test suite and typecheck

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

**Step 3: Run smoke test**

Run: `bun run smoke:web-designer`
Expected: Agent starts and responds without crash
