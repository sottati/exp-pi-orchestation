import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceManager } from "./workspace-manager";

const TEST_ROOT = join(import.meta.dir, "__workspace_manager_test__");
const DATA_DIR = join(TEST_ROOT, ".runtime-data");
const WS_ONE = join(TEST_ROOT, "repo-one");
const WS_TWO = join(TEST_ROOT, "repo-two");
const OUTSIDE = join(import.meta.dir, "__workspace_outside__");

beforeEach(() => {
  mkdirSync(WS_ONE, { recursive: true });
  mkdirSync(WS_TWO, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  test("registers and switches active workspace inside allowed roots", () => {
    const manager = new WorkspaceManager({
      dataDir: DATA_DIR,
      allowedRoots: [TEST_ROOT],
    });

    const first = manager.registerWorkspace({
      path: WS_ONE,
      workspaceId: "ws-one",
      name: "Repo One",
      setActive: true,
    });
    expect(first.workspaceId).toBe("ws-one");
    expect(manager.getActiveWorkspaceId()).toBe("ws-one");

    const second = manager.registerWorkspace({
      path: WS_TWO,
      workspaceId: "ws-two",
      name: "Repo Two",
      setActive: false,
    });
    expect(second.workspaceId).toBe("ws-two");
    expect(manager.getWorkspace("ws-two")?.path).toBe(WS_TWO);

    const activated = manager.setActiveWorkspace("ws-two");
    expect(activated.workspaceId).toBe("ws-two");
    expect(manager.getActiveWorkspacePath()).toBe(WS_TWO);

    expect(existsSync(join(DATA_DIR, "workspaces.json"))).toBe(true);
  });

  test("rejects workspace outside allowed roots", () => {
    const manager = new WorkspaceManager({
      dataDir: DATA_DIR,
      allowedRoots: [TEST_ROOT],
    });

    expect(() =>
      manager.registerWorkspace({
        path: OUTSIDE,
        workspaceId: "outside",
        setActive: true,
      }),
    ).toThrow();
  });
});

