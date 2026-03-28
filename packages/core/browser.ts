import { errorMessage } from "./errors";

export interface BrowseResult {
  content: string;
  title: string;
  url: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8080";
const BROWSE_SERVICE_URL = process.env.BROWSE_SERVICE_URL ?? "http://localhost:8001";
const SEARCH_TIMEOUT_MS = 20_000;
const BROWSE_TIMEOUT_MS = 60_000;
const INTERACT_TIMEOUT_MS = 130_000;

function validateHttpUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult> {
  try {
    const targetUrl = validateHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSE_TIMEOUT_MS);
    try {
      const res = await fetch(`${BROWSE_SERVICE_URL}/browse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl, wait_for: waitFor ?? null }),
        signal: controller.signal,
      });
      const data = await res.json() as { markdown?: string; title?: string; url?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Browse service returned HTTP ${res.status}`);
      }
      return {
        content: data.markdown ?? "",
        title: data.title ?? "",
        url: data.url ?? targetUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { content: `Error browsing ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}

export async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const capped = Math.min(Math.max(maxResults, 1), 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
    const res = await fetch(searchUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (data.results ?? []).slice(0, capped).map(r => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
    if (results.length === 0) {
      return [{ title: "Search Error", url: "", snippet: `No results found for "${query}"` }];
    }
    return results;
  } catch (err) {
    return [{ title: "Search Error", url: "", snippet: `Error searching "${query}": ${errorMessage(err)}` }];
  } finally {
    clearTimeout(timer);
  }
}

// Compatibility stubs — used by frontend-tools.ts until Task 6 removes Playwright dependencies.
// These throw at call-time so the module loads cleanly while making the unavailability explicit.
export function truncateContent(text: string, limit: number = 8000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeLaunchAndRun<T>(_fn: (page: any) => Promise<T>): Promise<T> {
  throw new Error(
    "safeLaunchAndRun is no longer available: Playwright has been removed. " +
    "Use browseUrl or interactWithPage instead.",
  );
}

export async function interactWithPage(url: string, task: string): Promise<BrowseResult> {
  try {
    const targetUrl = validateHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERACT_TIMEOUT_MS);
    try {
      const res = await fetch(`${BROWSE_SERVICE_URL}/interact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl, task }),
        signal: controller.signal,
      });
      const data = await res.json() as { result?: string; final_url?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Browse service returned HTTP ${res.status}`);
      }
      return {
        content: data.result ?? "",
        title: "",
        url: data.final_url ?? targetUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { content: `Error interacting with ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}
