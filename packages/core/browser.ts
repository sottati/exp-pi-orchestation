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
const BROWSE_TIMEOUT_MS = readPositiveIntEnv("BROWSE_TIMEOUT_MS", 90_000);
const INTERACT_TIMEOUT_MS = 130_000;
const MAX_ERROR_BODY_CHARS = 400;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

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

function truncateForError(text: string, max = MAX_ERROR_BODY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function readJsonObject(response: Response): Promise<{ json: Record<string, unknown> | null; rawBody: string }> {
  const rawBody = await response.text();
  if (!rawBody.trim()) return { json: null, rawBody };
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { json: parsed as Record<string, unknown>, rawBody };
    }
    return { json: null, rawBody };
  } catch {
    return { json: null, rawBody };
  }
}

function buildHttpError(
  endpoint: string,
  status: number,
  json: Record<string, unknown> | null,
  rawBody: string,
): string {
  const serviceError = typeof json?.error === "string" ? json.error.trim() : "";
  if (serviceError) return `${endpoint} returned HTTP ${status}: ${serviceError}`;
  const body = normalizeWhitespace(rawBody);
  if (body) {
    return `${endpoint} returned HTTP ${status}: ${truncateForError(body)}`;
  }
  return `${endpoint} returned HTTP ${status}`;
}

export async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult> {
  const endpoint = `${BROWSE_SERVICE_URL}/browse`;
  try {
    const targetUrl = validateHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSE_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl, wait_for: waitFor ?? null }),
        signal: controller.signal,
      });
      const { json, rawBody } = await readJsonObject(res);
      if (!res.ok) {
        throw new Error(buildHttpError(endpoint, res.status, json, rawBody));
      }
      if (!json) throw new Error(`${endpoint} returned invalid JSON.`);
      if (typeof json.error === "string" && json.error.trim()) {
        throw new Error(json.error.trim());
      }
      return {
        content: typeof json.markdown === "string" ? json.markdown : "",
        title: typeof json.title === "string" ? json.title : "",
        url: typeof json.url === "string" ? json.url : targetUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = isAbortError(err)
      ? `Request to ${endpoint} timed out after ${BROWSE_TIMEOUT_MS}ms`
      : errorMessage(err);
    console.error(`[browser] browseUrl failed url=${url}: ${msg}`);
    return { content: `Error browsing ${url}: ${msg}`, title: "Error", url };
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
  const endpoint = `${BROWSE_SERVICE_URL}/interact`;
  try {
    const targetUrl = validateHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERACT_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl, task }),
        signal: controller.signal,
      });
      const { json, rawBody } = await readJsonObject(res);
      if (!res.ok) {
        throw new Error(buildHttpError(endpoint, res.status, json, rawBody));
      }
      if (!json) throw new Error(`${endpoint} returned invalid JSON.`);
      if (typeof json.error === "string" && json.error.trim()) {
        throw new Error(json.error.trim());
      }
      return {
        content: typeof json.result === "string" ? json.result : "",
        title: "",
        url: typeof json.final_url === "string" ? json.final_url : targetUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = isAbortError(err)
      ? `Request to ${endpoint} timed out after ${INTERACT_TIMEOUT_MS}ms`
      : errorMessage(err);
    // Do not log task text here because it can contain credential placeholders.
    console.error(`[browser] interactWithPage failed url=${url}: ${msg}`);
    return { content: `Error interacting with ${url}: ${msg}`, title: "Error", url };
  }
}
