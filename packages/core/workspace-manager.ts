import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, basename, join } from "node:path";
import { now } from "./ids";

export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  activeWorkspaceId?: string;
  workspaces: WorkspaceRecord[];
  allowedRoots: string[];
}

export interface WorkspaceManagerOptions {
  dataDir?: string;
  fileName?: string;
  allowedRoots?: string[];
}

const DEFAULT_DATA_DIR = ".runtime-data";
const DEFAULT_FILE_NAME = "workspaces.json";

function normalizePath(pathValue: string): string {
  return resolve(pathValue);
}

function normalizeForCompare(pathValue: string): string {
  const resolved = normalizePath(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(pathValue: string, root: string): boolean {
  const rootResolved = normalizePath(root);
  const pathResolved = normalizePath(pathValue);
  const rel = relative(rootResolved, pathResolved);
  const isInside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!isInside) return false;
  if (process.platform !== "win32") return true;
  return normalizeForCompare(pathResolved).startsWith(normalizeForCompare(rootResolved));
}

function makeWorkspaceId(existing: Set<string>, preferred: string): string {
  const base = preferred
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  if (!existing.has(base)) return base;

  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function parseState(raw: string, allowedRoots: string[]): WorkspaceState {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    const validWorkspaces = workspaces
      .filter((ws): ws is WorkspaceRecord => {
        if (!ws || typeof ws !== "object") return false;
        const rec = ws as WorkspaceRecord;
        return typeof rec.workspaceId === "string"
          && typeof rec.name === "string"
          && typeof rec.path === "string"
          && typeof rec.createdAt === "number"
          && typeof rec.updatedAt === "number";
      })
      .map((ws) => ({ ...ws, path: normalizePath(ws.path) }));
    const activeWorkspaceId = typeof parsed.activeWorkspaceId === "string"
      ? parsed.activeWorkspaceId
      : undefined;
    return { activeWorkspaceId, workspaces: validWorkspaces, allowedRoots };
  } catch {
    return { activeWorkspaceId: undefined, workspaces: [], allowedRoots };
  }
}

export class WorkspaceManager {
  private readonly filePath: string;
  private state: WorkspaceState;

  constructor(opts?: WorkspaceManagerOptions) {
    const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;
    const fileName = opts?.fileName ?? DEFAULT_FILE_NAME;
    this.filePath = join(dataDir, fileName);
    const allowedRoots = (opts?.allowedRoots ?? []).map((root) => normalizePath(root));

    const raw = existsSync(this.filePath) ? readFileSync(this.filePath, "utf-8") : "";
    this.state = parseState(raw, allowedRoots);

    // Auto-register current repository as a safe default workspace if none exists.
    if (this.state.workspaces.length === 0) {
      try {
        this.registerWorkspace({ path: process.cwd(), name: basename(process.cwd()), setActive: true });
      } catch {
        // If cwd is outside allowed roots, require explicit workspace registration.
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const stable = {
      activeWorkspaceId: this.state.activeWorkspaceId,
      allowedRoots: this.state.allowedRoots,
      workspaces: this.state.workspaces,
    };
    writeFileSync(this.filePath, JSON.stringify(stable, null, 2), "utf-8");
  }

  getAllowedRoots(): string[] {
    return [...this.state.allowedRoots];
  }

  setAllowedRoots(roots: string[]): void {
    this.state.allowedRoots = roots.map((root) => normalizePath(root));
    this.persist();
  }

  isPathAllowed(pathValue: string): boolean {
    const target = normalizePath(pathValue);
    if (this.state.allowedRoots.length === 0) return true;
    return this.state.allowedRoots.some((root) => isPathInsideRoot(target, root));
  }

  private assertPathAllowed(pathValue: string): void {
    if (!this.isPathAllowed(pathValue)) {
      const roots = this.state.allowedRoots.join(", ");
      throw new Error(`Path "${pathValue}" is outside allowed roots: ${roots}`);
    }
  }

  listWorkspaces(): WorkspaceRecord[] {
    return [...this.state.workspaces].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.state.workspaces.find((ws) => ws.workspaceId === workspaceId);
  }

  getActiveWorkspaceId(): string | undefined {
    return this.state.activeWorkspaceId;
  }

  getActiveWorkspace(): WorkspaceRecord | undefined {
    const activeId = this.state.activeWorkspaceId;
    if (!activeId) return undefined;
    return this.getWorkspace(activeId);
  }

  getActiveWorkspacePath(): string | undefined {
    return this.getActiveWorkspace()?.path;
  }

  resolveWorkspace(workspaceId?: string): WorkspaceRecord | undefined {
    if (workspaceId) return this.getWorkspace(workspaceId);
    return this.getActiveWorkspace();
  }

  registerWorkspace(input: {
    path: string;
    workspaceId?: string;
    name?: string;
    setActive?: boolean;
  }): WorkspaceRecord {
    const targetPath = normalizePath(input.path);
    this.assertPathAllowed(targetPath);

    if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
      throw new Error(`Workspace path "${targetPath}" does not exist or is not a directory.`);
    }

    const existing = this.state.workspaces.find((ws) => normalizeForCompare(ws.path) === normalizeForCompare(targetPath));
    const timestamp = now();
    if (existing) {
      existing.name = input.name?.trim() || existing.name;
      existing.updatedAt = timestamp;
      if (input.setActive) this.state.activeWorkspaceId = existing.workspaceId;
      this.persist();
      return { ...existing };
    }

    const existingIds = new Set(this.state.workspaces.map((ws) => ws.workspaceId));
    const workspaceId = input.workspaceId
      ? makeWorkspaceId(existingIds, input.workspaceId)
      : makeWorkspaceId(existingIds, basename(targetPath));

    const record: WorkspaceRecord = {
      workspaceId,
      name: input.name?.trim() || basename(targetPath) || workspaceId,
      path: targetPath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.state.workspaces.push(record);
    if (input.setActive || !this.state.activeWorkspaceId) {
      this.state.activeWorkspaceId = workspaceId;
    }
    this.persist();
    return { ...record };
  }

  setActiveWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace "${workspaceId}" not found.`);
    this.state.activeWorkspaceId = workspaceId;
    workspace.updatedAt = now();
    this.persist();
    return { ...workspace };
  }
}
