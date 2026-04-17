import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStorePort } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleTasksToolOptions {
  credentialStore?: CredentialStorePort;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createGoogleTasksToolEntries(opts?: GoogleTasksToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const tasksList: ToolEntry = {
    name: "tasks_list",
    source: "local",
    description: "List tasks from Google Tasks. Can filter by task list and show completed tasks.",
    parameters: Type.Object({
      taskListId: Type.Optional(Type.String({ description: "Task list ID (default: '@default' — the primary list)" })),
      showCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks (default: false)" })),
      maxResults: Type.Optional(Type.Number({ description: `Max tasks to return (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const taskListId = (params.taskListId as string) ?? "@default";
      const showCompleted = (params.showCompleted as boolean) ?? false;
      const limit = Math.min((params.maxResults as number | undefined) ?? maxResults, maxResults);

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const tasks = google.tasks({ version: "v1", auth });

        const res = await tasks.tasks.list({
          tasklist: taskListId,
          maxResults: limit,
          showCompleted,
          showHidden: false,
        });

        const items = (res.data.items ?? []).map(t => ({
          id: t.id,
          title: t.title,
          notes: t.notes,
          status: t.status, // "needsAction" or "completed"
          due: t.due,
          completed: t.completed,
          updated: t.updated,
          parent: t.parent,
        }));

        const resultData = { taskListId, taskCount: items.length, showCompleted, tasks: items };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const tasksCreate: ToolEntry = {
    name: "tasks_create",
    source: "local",
    description: "Create a new task in Google Tasks.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      notes: Type.Optional(Type.String({ description: "Task notes/description" })),
      due: Type.Optional(Type.String({ description: "Due date (ISO 8601, e.g. '2024-01-15T00:00:00Z')" })),
      taskListId: Type.Optional(Type.String({ description: "Task list ID (default: '@default')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const title = params.title as string;
      const notes = params.notes as string | undefined;
      const due = params.due as string | undefined;
      const taskListId = (params.taskListId as string) ?? "@default";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const tasks = google.tasks({ version: "v1", auth });

        const res = await tasks.tasks.insert({
          tasklist: taskListId,
          requestBody: { title, notes, due },
        });

        const resultData = {
          taskId: res.data.id,
          title: res.data.title,
          due: res.data.due,
          status: res.data.status,
        };
        return textResult(`Task created: "${title}"${due ? ` (due: ${due})` : ""}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const tasksComplete: ToolEntry = {
    name: "tasks_complete",
    source: "local",
    description: "Mark a Google Tasks task as completed.",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task ID to complete" }),
      taskListId: Type.Optional(Type.String({ description: "Task list ID (default: '@default')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const taskId = params.taskId as string;
      const taskListId = (params.taskListId as string) ?? "@default";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const tasks = google.tasks({ version: "v1", auth });

        const res = await tasks.tasks.patch({
          tasklist: taskListId,
          task: taskId,
          requestBody: { status: "completed" },
        });

        const resultData = {
          taskId: res.data.id,
          title: res.data.title,
          status: res.data.status,
          completed: res.data.completed,
        };
        return textResult(`Task completed: "${res.data.title}"`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [tasksList, tasksCreate, tasksComplete];
}
