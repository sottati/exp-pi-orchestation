import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";

export interface ExplorerToolOptions {
  credentialStore?: CredentialStore;
}

async function resolveTaskCredentialPlaceholders(
  task: string,
  url: string,
  credentialStore?: CredentialStore,
): Promise<string> {
  if (!credentialStore?.enabled) return task;
  let domain: string;
  try {
    domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return task;
  }
  const creds = await credentialStore.get(domain);
  if (!creds) return task;
  return task.replace(/\{\{credential:([^}]+)\}\}/g, (_match, key: string) => {
    return creds[key] ?? _match;
  });
}

export function createExplorerToolEntries(opts: ExplorerToolOptions): ToolEntry[] {
  const { credentialStore } = opts;

  const browseUrl: ToolEntry = {
    name: "browse_url",
    source: "local",
    description: "Navigate to a URL and extract clean markdown content. Returns the page title and final URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to browse." }),
      waitFor: Type.Optional(Type.String({ description: "CSS selector to wait for before extracting content." })),
    }),
    execute: async (_toolCallId, params) => {
      const { browseUrl: browse } = await import("./browser");
      const result = await browse(params.url as string, params.waitFor as string | undefined);
      if (result.title === "Error" || result.content.startsWith("Error browsing ")) {
        throw new Error(result.content);
      }
      return {
        content: [{ type: "text" as const, text: `# ${result.title}\nURL: ${result.url}\n\n${result.content}` }],
        details: { title: result.title, url: result.url },
      };
    },
    defaultPermission: "allow",
    available: true,
  };

  const searchWeb: ToolEntry = {
    name: "search_web",
    source: "local",
    description: "Search the web using SearXNG. Returns a list of results with title, URL, and snippet.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (1-10, default 5)." })),
    }),
    execute: async (_toolCallId, params) => {
      const { searchWeb: search } = await import("./browser");
      const results = await search(params.query as string, params.maxResults as number | undefined);
      const first = results[0];
      if (first && first.title === "Search Error") {
        throw new Error(first.snippet || `Search failed for query: ${String(params.query)}`);
      }
      const text = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return {
        content: [{ type: "text" as const, text: text || "No results found." }],
        details: { results },
      };
    },
    defaultPermission: "allow",
    available: true,
  };

  const interactPage: ToolEntry = {
    name: "interact_page",
    source: "local",
    description: "Autonomously interact with a web page using a natural language task description. browser-use navigates, clicks, fills forms, and performs actions to complete the task. Supports {{credential:fieldname}} placeholders for secure credential injection.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      task: Type.String({ description: "Natural language description of what to accomplish. E.g. 'Log in with username {{credential:username}} and navigate to the reports section'." }),
    }),
    execute: async (_toolCallId, params) => {
      const { interactWithPage } = await import("./browser");
      const url = params.url as string;
      const task = await resolveTaskCredentialPlaceholders(
        params.task as string,
        url,
        credentialStore,
      );
      const result = await interactWithPage(url, task);
      if (result.title === "Error" || result.content.startsWith("Error interacting with ")) {
        throw new Error(result.content);
      }
      return {
        content: [{ type: "text" as const, text: `# Interaction Complete\nURL: ${result.url}\n\n${result.content}` }],
        details: { url: result.url },
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [browseUrl, searchWeb, interactPage];
}
