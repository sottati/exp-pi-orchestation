import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import type { PageAction } from "./browser";

export interface ExplorerToolOptions {
  credentialStore?: CredentialStore;
}

const PASSWORD_PATTERNS = /password|secret|passwd|token|api.?key/i;

export function redactActions(actions: PageAction[]): PageAction[] {
  return actions.map(action => {
    if (action.type === "fill" && PASSWORD_PATTERNS.test(action.selector)) {
      return { ...action, value: "***REDACTED***" };
    }
    return action;
  });
}

async function resolveCredentialPlaceholders(
  actions: PageAction[],
  url: string,
  credentialStore?: CredentialStore,
): Promise<PageAction[]> {
  if (!credentialStore?.enabled) return actions;
  let domain: string;
  try {
    domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return actions;
  }
  const creds = await credentialStore.get(domain);
  if (!creds) return actions;
  return actions.map(action => {
    if (action.type !== "fill") return action;
    const match = action.value.match(/^\{\{credential:(.+)\}\}$/);
    if (!match) return action;
    const key = match[1]!;
    const resolved = creds[key];
    if (resolved === undefined) return action;
    return { ...action, value: resolved };
  });
}

export function createExplorerToolEntries(opts: ExplorerToolOptions): ToolEntry[] {
  const { credentialStore } = opts;

  const browseUrl: ToolEntry = {
    name: "browse_url",
    source: "local",
    description: "Navigate to a URL and extract a DOM snapshot (text + forms/inputs/buttons + iframe summaries). Returns the page title and final URL.",
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
    description: "Search the web using DuckDuckGo. Returns a list of results with title, URL, and snippet.",
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
    description: "Navigate to a URL, perform actions (click, fill, select, wait), and optionally follow up to other URLs. Supports credential auto-injection via {{credential:username}} and {{credential:password}} placeholders. Returns a DOM snapshot of the final page(s).",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      actions: Type.Array(
        Type.Object({
          type: Type.Union([
            Type.Literal("click"),
            Type.Literal("fill"),
            Type.Literal("select"),
            Type.Literal("wait"),
          ]),
          selector: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          timeout: Type.Optional(Type.Number()),
        }),
        { description: "Sequence of page actions." },
      ),
      followUpUrls: Type.Optional(
        Type.Array(Type.String(), { description: "URLs to navigate to after actions (same browser session)." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { interactWithPage } = await import("./browser");
      let actions = params.actions as PageAction[];
      const url = params.url as string;
      const followUpUrls = params.followUpUrls as string[] | undefined;
      actions = await resolveCredentialPlaceholders(actions, url, credentialStore);
      const result = await interactWithPage(url, actions, followUpUrls);
      if (result.title === "Error" || result.content.startsWith("Error interacting with ")) {
        throw new Error(result.content);
      }
      return {
        content: [{ type: "text" as const, text: `# ${result.title}\nURL: ${result.url}\n\n${result.content}` }],
        details: {
          title: result.title,
          url: result.url,
          actions: redactActions(params.actions as PageAction[]),
        },
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [browseUrl, searchWeb, interactPage];
}
