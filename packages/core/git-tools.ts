import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import type { WorkspaceManager, WorkspaceRecord } from "./workspace-manager";

export interface GitToolOptions {
  workspaceManager: WorkspaceManager;
  commandTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 45_000;
const MAX_TIMEOUT = 180_000;
const MAX_STDOUT = 16_000;
const MAX_STDERR = 8_000;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number) {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      command,
      args,
      cwd,
      timedOut,
      exitCode,
      stdout: stdout.slice(0, MAX_STDOUT),
      stderr: stderr.slice(0, MAX_STDERR),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveWorkspace(
  manager: WorkspaceManager,
  params: Record<string, unknown>,
): { workspace?: WorkspaceRecord; error?: string } {
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : undefined;
  const workspace = manager.resolveWorkspace(workspaceId);
  if (!workspace) {
    if (workspaceId) return { error: `Workspace '${workspaceId}' not found.` };
    return { error: "No active workspace configured. Use workspace_list/workspace_set_active first." };
  }
  return { workspace };
}

function successMessage(result: ReturnType<typeof runProcess> extends Promise<infer T> ? T : never): string {
  const status = result.timedOut
    ? "timed out"
    : result.exitCode === 0
      ? "ok"
      : `exitCode=${result.exitCode}`;
  return `Command ${status}: ${result.command} ${result.args.join(" ")}`.trim();
}

function sanitizePathspecs(raw: string[] | undefined): string[] {
  const paths = (raw ?? []).map((item) => item.trim()).filter(Boolean);
  for (const path of paths) {
    if (path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
      throw new Error(`Invalid pathspec "${path}". Parent-directory traversal is not allowed.`);
    }
  }
  return paths;
}

function makeGitEntry(input: {
  name: string;
  description: string;
  parameters: ToolEntry["parameters"];
  defaultPermission: ToolEntry["defaultPermission"];
  run: (workspace: WorkspaceRecord, params: Record<string, unknown>) => { args: string[]; timeoutMs?: number };
  command?: "git" | "gh";
}): (opts: GitToolOptions) => ToolEntry {
  return (opts) => ({
    name: input.name,
    source: "local",
    description: input.description,
    parameters: input.parameters,
    defaultPermission: input.defaultPermission,
    available: true,
    execute: async (_toolCallId, params) => {
      const resolved = resolveWorkspace(opts.workspaceManager, params);
      if (!resolved.workspace) return textResult(`Error: ${resolved.error}`);

      try {
        const { args, timeoutMs } = input.run(resolved.workspace, params);
        const result = await runProcess(
          input.command ?? "git",
          args,
          resolved.workspace.path,
          Math.min(timeoutMs ?? opts.commandTimeoutMs ?? DEFAULT_TIMEOUT, MAX_TIMEOUT),
        );
        const details = {
          workspaceId: resolved.workspace.workspaceId,
          workspacePath: resolved.workspace.path,
          ...result,
        };
        const header = successMessage(result);
        const body = JSON.stringify(details, null, 2);
        return textResult(`${header}\n${body}`, details);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  });
}

export function createGitToolEntries(opts: GitToolOptions): ToolEntry[] {
  const entriesFactory = [
    makeGitEntry({
      name: "git_status",
      description: "Show git status for the active workspace.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
      }),
      defaultPermission: "allow",
      run: () => ({ args: ["status", "--short", "--branch"] }),
    }),
    makeGitEntry({
      name: "git_diff",
      description: "Show git diff for the active workspace.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        staged: Type.Optional(Type.Boolean({ description: "Use --staged diff." })),
      }),
      defaultPermission: "allow",
      run: (_workspace, params) => ({
        args: ["diff", ...(params.staged ? ["--staged"] : [])],
      }),
    }),
    makeGitEntry({
      name: "git_log",
      description: "Show recent git commits (oneline).",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        limit: Type.Optional(Type.Number({ description: "Number of commits to return (default: 20)." })),
      }),
      defaultPermission: "allow",
      run: (_workspace, params) => {
        const limitRaw = typeof params.limit === "number" ? params.limit : 20;
        const limit = Math.min(Math.max(1, Math.floor(limitRaw)), 200);
        return { args: ["log", "--oneline", "-n", String(limit)] };
      },
    }),
    makeGitEntry({
      name: "git_list_branches",
      description: "List local git branches (or all with remotes).",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        all: Type.Optional(Type.Boolean({ description: "Include remotes with --all." })),
      }),
      defaultPermission: "allow",
      run: (_workspace, params) => ({
        args: ["branch", "--list", ...(params.all ? ["--all"] : [])],
      }),
    }),
    makeGitEntry({
      name: "git_checkout_branch",
      description: "Checkout an existing branch or create one.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        branch: Type.String({ description: "Target branch name." }),
        create: Type.Optional(Type.Boolean({ description: "Create branch if true." })),
        startPoint: Type.Optional(Type.String({ description: "Optional start point for branch creation." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const branch = params.branch as string;
        const create = Boolean(params.create);
        const startPoint = typeof params.startPoint === "string" ? params.startPoint : undefined;
        if (!create) return { args: ["checkout", branch] };
        return { args: ["checkout", "-b", branch, ...(startPoint ? [startPoint] : [])] };
      },
    }),
    makeGitEntry({
      name: "git_add",
      description: "Stage files with git add.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to stage (e.g. ['.'] or ['src/app.ts'])." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const paths = sanitizePathspecs(params.paths as string[] | undefined);
        if (paths.length === 0) return { args: ["add", "."] };
        return { args: ["add", "--", ...paths] };
      },
    }),
    makeGitEntry({
      name: "git_commit",
      description: "Create a git commit with message.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        message: Type.String({ description: "Commit message." }),
        all: Type.Optional(Type.Boolean({ description: "Include tracked files with -a." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const message = params.message as string;
        const all = Boolean(params.all);
        return { args: ["commit", ...(all ? ["-a"] : []), "-m", message] };
      },
    }),
    makeGitEntry({
      name: "git_fetch",
      description: "Fetch remote updates.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        remote: Type.Optional(Type.String({ description: "Remote name (default: origin)." })),
      }),
      defaultPermission: "allow",
      run: (_workspace, params) => {
        const remote = typeof params.remote === "string" ? params.remote : "origin";
        return { args: ["fetch", remote] };
      },
    }),
    makeGitEntry({
      name: "git_pull",
      description: "Pull remote changes.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        remote: Type.Optional(Type.String({ description: "Remote name (default: origin)." })),
        branch: Type.Optional(Type.String({ description: "Branch name (default: current)." })),
        rebase: Type.Optional(Type.Boolean({ description: "Use --rebase." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const remote = typeof params.remote === "string" ? params.remote : "origin";
        const branch = typeof params.branch === "string" ? params.branch : undefined;
        const rebase = Boolean(params.rebase);
        return { args: ["pull", ...(rebase ? ["--rebase"] : []), remote, ...(branch ? [branch] : [])] };
      },
    }),
    makeGitEntry({
      name: "git_push",
      description: "Push local branch to remote.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        remote: Type.Optional(Type.String({ description: "Remote name (default: origin)." })),
        branch: Type.Optional(Type.String({ description: "Branch name (default: current)." })),
        setUpstream: Type.Optional(Type.Boolean({ description: "Use --set-upstream." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const remote = typeof params.remote === "string" ? params.remote : "origin";
        const branch = typeof params.branch === "string" ? params.branch : undefined;
        const setUpstream = Boolean(params.setUpstream);
        return {
          args: ["push", ...(setUpstream ? ["--set-upstream"] : []), remote, ...(branch ? [branch] : [])],
        };
      },
    }),
    makeGitEntry({
      name: "git_merge_branch",
      description: "Merge another branch into the current branch.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        branch: Type.String({ description: "Branch to merge into current branch." }),
        noFf: Type.Optional(Type.Boolean({ description: "Use --no-ff." })),
      }),
      defaultPermission: "hitl",
      run: (_workspace, params) => {
        const branch = params.branch as string;
        const noFf = Boolean(params.noFf);
        return { args: ["merge", ...(noFf ? ["--no-ff"] : []), branch] };
      },
    }),
    makeGitEntry({
      name: "github_create_pr",
      description: "Create a GitHub Pull Request via gh CLI.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        title: Type.String({ description: "PR title." }),
        body: Type.Optional(Type.String({ description: "PR body/description." })),
        base: Type.Optional(Type.String({ description: "Target base branch." })),
        head: Type.Optional(Type.String({ description: "Source head branch." })),
        draft: Type.Optional(Type.Boolean({ description: "Create as draft PR." })),
      }),
      defaultPermission: "hitl",
      command: "gh",
      run: (_workspace, params) => {
        const title = params.title as string;
        const body = typeof params.body === "string" ? params.body : "";
        const base = typeof params.base === "string" ? params.base : undefined;
        const head = typeof params.head === "string" ? params.head : undefined;
        const draft = Boolean(params.draft);
        return {
          args: [
            "pr", "create",
            "--title", title,
            "--body", body,
            ...(base ? ["--base", base] : []),
            ...(head ? ["--head", head] : []),
            ...(draft ? ["--draft"] : []),
          ],
          timeoutMs: 120_000,
        };
      },
    }),
    makeGitEntry({
      name: "github_merge_pr",
      description: "Merge a GitHub Pull Request via gh CLI.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (defaults to active)." })),
        prNumber: Type.Optional(Type.Number({ description: "PR number. Omit to use current branch PR." })),
        method: Type.Optional(Type.Union([
          Type.Literal("merge"),
          Type.Literal("squash"),
          Type.Literal("rebase"),
        ], { description: "Merge method." })),
        deleteBranch: Type.Optional(Type.Boolean({ description: "Delete local/remote branch after merge." })),
      }),
      defaultPermission: "hitl",
      command: "gh",
      run: (_workspace, params) => {
        const prNumber = typeof params.prNumber === "number" ? String(Math.floor(params.prNumber)) : undefined;
        const method = typeof params.method === "string" ? params.method : "squash";
        const deleteBranch = Boolean(params.deleteBranch);
        const methodFlag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
        return {
          args: [
            "pr", "merge",
            ...(prNumber ? [prNumber] : []),
            methodFlag,
            ...(deleteBranch ? ["--delete-branch"] : []),
          ],
          timeoutMs: 120_000,
        };
      },
    }),
  ];

  return entriesFactory.map((factory) => factory(opts));
}
