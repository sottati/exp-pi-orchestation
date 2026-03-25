import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

export interface DebuggerToolOptions {
  maxFileSize?: number;
  maxSearchResults?: number;
  basePath?: string;
}

const DEFAULT_MAX_FILE_SIZE = 512 * 1024; // 512KB
const DEFAULT_MAX_SEARCH_RESULTS = 50;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function isPathSafe(filePath: string, basePath?: string): boolean {
  if (!basePath) return true;
  const resolved = resolve(filePath);
  return resolved.startsWith(resolve(basePath));
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".runtime-data", "dist", "build"]);

export function createDebuggerToolEntries(opts?: DebuggerToolOptions): ToolEntry[] {
  const maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxSearchResults = opts?.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const basePath = opts?.basePath;

  const readFile: ToolEntry = {
    name: "read_file",
    source: "local",
    description: "Read the contents of a source file. Returns the file text with line numbers for reference in reviews and debugging.",
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
        const resultData = {
          filePath,
          totalLines: allLines.length,
          startLine: start,
          endLine: end,
          linesReturned: selectedLines.length,
        };
        return textResult(numbered, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const searchCode: ToolEntry = {
    name: "search_code",
    source: "local",
    description: "Search for a text pattern across files in a directory. Returns matching lines with file paths and line numbers. Useful for finding usages, definitions, and patterns.",
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
          try {
            names = readdirSync(dir) as unknown as string[];
          } catch {
            return;
          }

          for (const name of names) {
            if (matches.length >= maxSearchResults) return;

            const fullPath = join(dir, name);

            let stat;
            try {
              stat = statSync(fullPath);
            } catch {
              continue;
            }

            if (stat.isDirectory()) {
              if (SKIP_DIRS.has(name)) continue;
              walkDir(fullPath);
              continue;
            }

            if (!stat.isFile()) continue;

            // Filter by extension if specified
            if (extensions && extensions.length > 0) {
              const hasExt = extensions.some(ext => name.endsWith(ext));
              if (!hasExt) continue;
            }

            // Skip large files
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
            } catch {
              // Skip unreadable files
            }
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
    description: "List files and subdirectories in a directory. Returns names, types, and sizes. Useful for understanding project structure.",
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
          try {
            names = readdirSync(dir) as unknown as string[];
          } catch {
            return;
          }

          for (const name of names) {
            const fullPath = join(dir, name);

            let stat;
            try {
              stat = statSync(fullPath);
            } catch {
              continue;
            }

            if (stat.isDirectory()) {
              if (SKIP_DIRS.has(name)) continue;
              items.push({ path: fullPath, type: "directory" });
              if (recursive && depth < 3) {
                listDir(fullPath, depth + 1);
              }
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

  return [readFile, searchCode, listDirectory];
}
