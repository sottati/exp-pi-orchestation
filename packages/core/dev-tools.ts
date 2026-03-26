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
