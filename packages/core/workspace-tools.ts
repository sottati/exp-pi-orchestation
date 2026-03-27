import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import type { WorkspaceManager } from "./workspace-manager";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export interface WorkspaceToolOptions {
  workspaceManager: WorkspaceManager;
}

export function createWorkspaceToolEntries(opts: WorkspaceToolOptions): ToolEntry[] {
  const manager = opts.workspaceManager;

  const workspaceRoots: ToolEntry = {
    name: "workspace_roots",
    source: "local",
    description: "List allowed root directories for workspace registration and access checks.",
    parameters: Type.Object({}),
    defaultPermission: "allow",
    available: true,
    execute: async () => {
      try {
        const roots = manager.getAllowedRoots();
        const resultData = {
          unrestricted: roots.length === 0,
          allowedRoots: roots,
        };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const workspaceList: ToolEntry = {
    name: "workspace_list",
    source: "local",
    description: "List registered workspaces and indicate which one is active.",
    parameters: Type.Object({}),
    defaultPermission: "allow",
    available: true,
    execute: async () => {
      try {
        const activeWorkspaceId = manager.getActiveWorkspaceId();
        const workspaces = manager.listWorkspaces();
        const resultData = {
          activeWorkspaceId,
          workspaceCount: workspaces.length,
          workspaces,
        };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const workspaceGetActive: ToolEntry = {
    name: "workspace_get_active",
    source: "local",
    description: "Get the currently active workspace.",
    parameters: Type.Object({}),
    defaultPermission: "allow",
    available: true,
    execute: async () => {
      try {
        const active = manager.getActiveWorkspace();
        if (!active) {
          return textResult("No active workspace configured.", { found: false });
        }
        const resultData = { found: true, workspace: active };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const workspaceRegister: ToolEntry = {
    name: "workspace_register",
    source: "local",
    description: "Register a local directory as a workspace. Optionally set it as active.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the workspace directory." }),
      workspaceId: Type.Optional(Type.String({ description: "Optional workspace ID (slug)." })),
      name: Type.Optional(Type.String({ description: "Optional display name." })),
      setActive: Type.Optional(Type.Boolean({ description: "Set this workspace as active (default: true)." })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const path = params.path as string;
      const workspaceId = params.workspaceId as string | undefined;
      const name = params.name as string | undefined;
      const setActive = (params.setActive as boolean | undefined) ?? true;

      try {
        const workspace = manager.registerWorkspace({
          path,
          workspaceId,
          name,
          setActive,
        });
        const resultData = { registered: true, workspace, setActive };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const workspaceSetActive: ToolEntry = {
    name: "workspace_set_active",
    source: "local",
    description: "Set the active workspace by workspaceId.",
    parameters: Type.Object({
      workspaceId: Type.String({ description: "Registered workspace ID to activate." }),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const workspaceId = params.workspaceId as string;
      try {
        const workspace = manager.setActiveWorkspace(workspaceId);
        const resultData = { activeWorkspaceId: workspace.workspaceId, workspace };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [workspaceRoots, workspaceList, workspaceGetActive, workspaceRegister, workspaceSetActive];
}
