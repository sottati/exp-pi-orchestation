import { errorMessage } from "./errors";
import { fileURLToPath } from "node:url";

export interface BrowseResult {
  content: string;
  title: string;
  url: string;
}

export type PageAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "wait"; selector?: string; timeout?: number };

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_CONTENT_LENGTH = 8000;
const NAV_TIMEOUT = 30_000;
const LAUNCH_TIMEOUT = 30_000;
const OPERATION_TIMEOUT = 60_000;
const BROWSER_UNAVAILABLE_MS = 5 * 60_000;
const SEARCH_TIMEOUT = 20_000;
const NODE_BRIDGE_TIMEOUT = 120_000;
const NODE_BRIDGE_FORCE = "1";
const NODE_BRIDGE_DISABLE = "0";

let browserUnavailableUntil = 0;
let browserUnavailableReason = "";

export function truncateContent(text: string, limit: number = MAX_CONTENT_LENGTH): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

async function getPlaywright() {
  try {
    const pw = await import("playwright");
    return pw;
  } catch {
    throw new Error("Playwright is not installed. Run: bun add playwright && bunx playwright install chromium");
  }
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function launchAndRun<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  if (Date.now() < browserUnavailableUntil) {
    throw new Error(`Browser engine temporarily unavailable: ${browserUnavailableReason}`);
  }

  const pw = await getPlaywright();
  try {
    const browser = await withTimeout(
      pw.chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT }),
      OPERATION_TIMEOUT,
      "chromium.launch",
    );
    const page = await browser.newPage();
    try {
      return await withTimeout(fn(page), OPERATION_TIMEOUT, "browser operation");
    } finally {
      await withTimeout(browser.close(), 10_000, "browser.close").catch(() => {});
    }
  } finally {
    // no-op
  }
}

function markBrowserUnavailable(msg: string): void {
  browserUnavailableReason = msg;
  browserUnavailableUntil = Date.now() + BROWSER_UNAVAILABLE_MS;
}

function isLaunchFailureMessage(msg: string): boolean {
  const text = msg.toLowerCase();
  return (
    text.includes("executable doesn't exist") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("browsertype.launch") ||
    text.includes("chromium.launch") ||
    text.includes("chrome-headless-shell") ||
    text.includes("temporarily unavailable")
  );
}

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

function shouldForceNodeBridge(): boolean {
  return process.env.PLAYWRIGHT_NODE_BRIDGE === NODE_BRIDGE_FORCE;
}

function shouldDisableNodeBridge(): boolean {
  return process.env.PLAYWRIGHT_NODE_BRIDGE === NODE_BRIDGE_DISABLE;
}

function hasNodeBinary(): boolean {
  if (!isBunRuntime()) return false;
  try {
    return Boolean(Bun.which("node"));
  } catch {
    return false;
  }
}

function shouldPreferNodeBridge(): boolean {
  if (shouldDisableNodeBridge()) return false;
  if (shouldForceNodeBridge()) return true;
  return isBunRuntime() && hasNodeBinary();
}

function shouldUseNodeBridgeForError(err: unknown): boolean {
  if (shouldDisableNodeBridge()) return false;
  if (!isBunRuntime()) return false;
  if (shouldForceNodeBridge()) return true;
  return isLaunchFailureMessage(errorMessage(err));
}

interface NodeBridgeTaskBrowse {
  kind: "browse";
  url: string;
  waitFor?: string;
  maxContentLength: number;
  navTimeout: number;
  launchTimeout: number;
}

interface NodeBridgeTaskInteract {
  kind: "interact";
  url: string;
  actions: PageAction[];
  followUpUrls?: string[];
  maxContentLength: number;
  navTimeout: number;
  launchTimeout: number;
}

type NodeBridgeTask = NodeBridgeTaskBrowse | NodeBridgeTaskInteract;

class NodeBridgeTaskError extends Error {}
class NodeBridgeInfraError extends Error {}

async function runNodeBridgeTask(task: NodeBridgeTask): Promise<BrowseResult> {
  if (shouldDisableNodeBridge()) {
    throw new NodeBridgeInfraError("Node browser bridge is disabled by PLAYWRIGHT_NODE_BRIDGE=0");
  }

  const scriptPath = fileURLToPath(new URL("./browser-node-bridge.mjs", import.meta.url));
  const proc = Bun.spawn(["node", scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(task));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* ignore */ }
  }, NODE_BRIDGE_TIMEOUT);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (timedOut) {
      throw new NodeBridgeInfraError(`Node browser bridge timed out after ${NODE_BRIDGE_TIMEOUT}ms`);
    }

    if (exitCode !== 0) {
      throw new NodeBridgeInfraError(`Node browser bridge failed (exit ${exitCode}): ${stderr || stdout || "unknown error"}`);
    }

    let parsed: { ok?: boolean; result?: BrowseResult; error?: string };
    try {
      parsed = JSON.parse(stdout || "{}") as { ok?: boolean; result?: BrowseResult; error?: string };
    } catch {
      throw new NodeBridgeInfraError(`Node browser bridge returned invalid JSON: ${stdout.slice(0, 400)}`);
    }

    if (!parsed.ok || !parsed.result) {
      throw new NodeBridgeTaskError(parsed.error || `Node browser bridge failed: ${stderr || "unknown error"}`);
    }

    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function safeLaunchAndRun<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  try {
    return await launchAndRun(fn);
  } catch (err) {
    const msg = errorMessage(err);
    if (isLaunchFailureMessage(msg)) {
      markBrowserUnavailable(msg);
    }
    throw err;
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  return input
    .replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeSearchResultUrl(rawHref: string): string {
  const decoded = decodeHtmlEntities(rawHref).trim();
  const withProtocol = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const parsed = new URL(withProtocol, "https://duckduckgo.com");
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) {
        try {
          return decodeURIComponent(uddg);
        } catch {
          return uddg;
        }
      }
    }
    return parsed.toString();
  } catch {
    return withProtocol;
  }
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const capped = Math.min(Math.max(maxResults, 1), 10);
  const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ href: string; titleRaw: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(html)) !== null) {
    links.push({
      href: match[1] ?? "",
      titleRaw: match[2] ?? "",
      start: match.index,
      end: linkRe.lastIndex,
    });
    if (links.length >= capped * 3) {
      break;
    }
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length; i++) {
    const current = links[i]!;
    const nextStart = links[i + 1]?.start ?? Math.min(html.length, current.end + 4000);
    const segment = html.slice(current.end, nextStart);
    const snippetMatch = segment.match(
      /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    const snippetRaw = snippetMatch?.[1] ?? snippetMatch?.[2] ?? "";

    const title = decodeHtmlEntities(stripHtml(current.titleRaw))
      .replace(/\s+/g, " ")
      .trim();
    const url = normalizeSearchResultUrl(current.href);
    const snippet = decodeHtmlEntities(stripHtml(snippetRaw))
      .replace(/\s+/g, " ")
      .trim();

    if (!title || !url) continue;
    results.push({ title, url, snippet });
    if (results.length >= capped) break;
  }

  return results;
}

async function searchWebViaHttp(query: string, maxResults: number): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseDuckDuckGoHtml(html, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

export async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult> {
  try {
    const targetUrl = validateHttpUrl(url);
    const bridgeTask: NodeBridgeTaskBrowse = {
      kind: "browse",
      url: targetUrl,
      waitFor,
      maxContentLength: MAX_CONTENT_LENGTH,
      navTimeout: NAV_TIMEOUT,
      launchTimeout: LAUNCH_TIMEOUT,
    };

    if (shouldPreferNodeBridge()) {
      try {
        return await runNodeBridgeTask(bridgeTask);
      } catch (err) {
        if (err instanceof NodeBridgeTaskError) throw err;
        if (shouldForceNodeBridge()) throw err;
      }
    }

    try {
      return await safeLaunchAndRun(async (page) => {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        if (waitFor) {
          await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
        }
        const title = await page.title();
        const content = await page.evaluate(() => {
          const selectors = ["nav", "header", "footer", "[role=navigation]", "[role=banner]", ".ad", ".ads", "#cookie-banner"];
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(el => el.remove());
          }
          return document.body?.innerText ?? "";
        });
        return { content: truncateContent(content), title, url: page.url() };
      });
    } catch (err) {
      if (!shouldUseNodeBridgeForError(err)) throw err;
      return await runNodeBridgeTask(bridgeTask);
    }
  } catch (err) {
    return { content: `Error browsing ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}

export async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const capped = Math.min(Math.max(maxResults, 1), 10);
  try {
    const results = await searchWebViaHttp(query, capped);
    if (results.length > 0) return results;
    return [{
      title: "Search Error",
      url: "",
      snippet: `Error searching "${query}": no parseable results returned by DuckDuckGo HTML`,
    }];
  } catch (err) {
    return [{ title: "Search Error", url: "", snippet: `Error searching "${query}": ${errorMessage(err)}` }];
  }
}

export async function interactWithPage(
  url: string,
  actions: PageAction[],
  followUpUrls?: string[],
): Promise<BrowseResult> {
  try {
    const targetUrl = validateHttpUrl(url);
    const bridgeTask: NodeBridgeTaskInteract = {
      kind: "interact",
      url: targetUrl,
      actions,
      followUpUrls,
      maxContentLength: MAX_CONTENT_LENGTH,
      navTimeout: NAV_TIMEOUT,
      launchTimeout: LAUNCH_TIMEOUT,
    };

    if (shouldPreferNodeBridge()) {
      try {
        return await runNodeBridgeTask(bridgeTask);
      } catch (err) {
        if (err instanceof NodeBridgeTaskError) throw err;
        if (shouldForceNodeBridge()) throw err;
      }
    }

    try {
      return await safeLaunchAndRun(async (page) => {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        for (const action of actions) {
          switch (action.type) {
            case "click":
              await page.click(action.selector, { timeout: 10_000 });
              break;
            case "fill":
              await page.fill(action.selector, action.value, { timeout: 10_000 });
              break;
            case "select":
              await page.selectOption(action.selector, action.value, { timeout: 10_000 });
              break;
            case "wait":
              if (action.selector) {
                await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10_000 }).catch(() => {});
              } else {
                await page.waitForTimeout(action.timeout ?? 3000);
              }
              break;
          }
        }
        const parts: string[] = [];
        const mainContent = await page.evaluate(() => document.body?.innerText ?? "");
        parts.push(truncateContent(mainContent, 4000));
        if (followUpUrls) {
          for (const followUrl of followUpUrls) {
            try {
              const nextUrl = validateHttpUrl(followUrl);
              await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
              const followContent = await page.evaluate(() => document.body?.innerText ?? "");
              parts.push(`\n--- ${nextUrl} ---\n${truncateContent(followContent, 4000)}`);
            } catch (err) {
              parts.push(`\n--- ${followUrl} ---\nError: ${errorMessage(err)}`);
            }
          }
        }
        const title = await page.title();
        return {
          content: truncateContent(parts.join("\n"), MAX_CONTENT_LENGTH),
          title,
          url: page.url(),
        };
      });
    } catch (err) {
      if (!shouldUseNodeBridgeForError(err)) throw err;
      return await runNodeBridgeTask(bridgeTask);
    }
  } catch (err) {
    return { content: `Error interacting with ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}
