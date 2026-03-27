import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createGitToolEntries } from "./git-tools";
import { WorkspaceManager } from "./workspace-manager";

const TEST_ROOT = join(import.meta.dir, "__git_tools_test__");
const DATA_DIR = join(TEST_ROOT, ".runtime-data");
const REPO_DIR = join(TEST_ROOT, "repo");

function getTool(name: string) {
  const manager = new WorkspaceManager({
    dataDir: DATA_DIR,
    allowedRoots: [TEST_ROOT],
  });
  return {
    manager,
    tool: createGitToolEntries({ workspaceManager: manager }).find((entry) => entry.name === name)!,
  };
}

beforeEach(() => {
  mkdirSync(REPO_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("git tools", () => {
  test("exposes expected git and github tool names", () => {
    const manager = new WorkspaceManager({
      dataDir: DATA_DIR,
      allowedRoots: [TEST_ROOT],
    });
    const names = createGitToolEntries({ workspaceManager: manager }).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "git_add",
      "git_checkout_branch",
      "git_commit",
      "git_diff",
      "git_fetch",
      "git_list_branches",
      "git_log",
      "git_merge_branch",
      "git_pull",
      "git_push",
      "git_status",
      "github_create_pr",
      "github_merge_pr",
    ]);
  });

  test("returns clear error when no active workspace exists", async () => {
    const { tool } = getTool("git_status");
    const result = await tool.execute("t-no-workspace", {});
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("No active workspace configured");
  });

  test("runs git_status in the active workspace", async () => {
    if (!Bun.which("git")) {
      expect(true).toBe(true);
      return;
    }

    const manager = new WorkspaceManager({
      dataDir: DATA_DIR,
      allowedRoots: [TEST_ROOT],
    });
    manager.registerWorkspace({
      path: REPO_DIR,
      workspaceId: "repo",
      name: "Repo",
      setActive: true,
    });

    const init = Bun.spawnSync(["git", "init"], { cwd: REPO_DIR });
    expect(init.exitCode).toBe(0);

    const tool = createGitToolEntries({ workspaceManager: manager }).find((entry) => entry.name === "git_status")!;
    const result = await tool.execute("t-status", {});
    const details = (result.details ?? {}) as Record<string, unknown>;

    expect(details.workspaceId).toBe("repo");
    expect(details.workspacePath).toBe(REPO_DIR);
    expect(details.command).toBe("git");
  });
});

