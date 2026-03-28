import { errorMessage } from "./errors";
import { fileURLToPath } from "node:url";

export interface BrowseResult {
  content: string;
  title: string;
  url: string;
}

export type PageAction =
  | { type: "click"; selector: string; timeout?: number }
  | { type: "fill"; selector: string; value: string; timeout?: number }
  | { type: "select"; selector: string; value: string; timeout?: number }
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
const CONTENT_WAIT_TIMEOUT = 12_000;
const NETWORK_IDLE_TIMEOUT = 8_000;
const BROWSER_UNAVAILABLE_MS = 5 * 60_000;
const SEARCH_TIMEOUT = 20_000;
const NODE_BRIDGE_TIMEOUT = 120_000;
const NODE_BRIDGE_FORCE = "1";
const NODE_BRIDGE_DISABLE = "0";
const MAX_FRAME_COUNT = 4;
const MAX_FIELD_COUNT = 12;
const MAX_TEXT_SNIPPET = 2400;
const MAX_HTML_SNIPPET = 1200;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
    try {
      const context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
        locale: "en-US",
        viewport: { width: 1366, height: 900 },
      });
      const page = await context.newPage();
      try {
        return await withTimeout(fn(page), OPERATION_TIMEOUT, "browser operation");
      } finally {
        await withTimeout(context.close(), 10_000, "browser.context.close").catch(() => {});
      }
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

interface DomFieldSummary {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  label?: string;
  text?: string;
}

interface DomFrameSummary {
  frameUrl: string;
  frameName: string;
  isMainFrame: boolean;
  readyState: string;
  appRootDetected: boolean;
  iframeCount: number;
  scriptCount: number;
  linkCount: number;
  text: string;
  htmlSnippet: string;
  forms: DomFieldSummary[];
  inputs: DomFieldSummary[];
  buttons: DomFieldSummary[];
}

async function waitForPageHydration(page: import("playwright").Page, waitFor?: string): Promise<void> {
  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: CONTENT_WAIT_TIMEOUT }).catch(() => {});
  }

  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
  await page.waitForFunction(
    () => {
      const body = document.body;
      if (!body) return false;
      const textLength = (body.innerText ?? "").trim().length;
      const interactiveCount = document.querySelectorAll("form,input,textarea,select,button").length;
      const iframeCount = document.querySelectorAll("iframe").length;
      return (
        document.readyState === "complete" ||
        textLength > 120 ||
        interactiveCount > 0 ||
        iframeCount > 0
      );
    },
    { timeout: CONTENT_WAIT_TIMEOUT },
  ).catch(() => {});
}

function summarizeField(field: DomFieldSummary): string {
  const parts = [
    field.tag,
    field.type ? `type=${field.type}` : "",
    field.id ? `id=${field.id}` : "",
    field.name ? `name=${field.name}` : "",
    field.placeholder ? `placeholder=${field.placeholder}` : "",
    field.label ? `label=${field.label}` : "",
    field.text ? `text=${field.text}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function formatFrameSummary(summary: DomFrameSummary): string {
  const lines: string[] = [];
  const frameHeader = summary.isMainFrame
    ? `Frame: main (${summary.frameUrl || "about:blank"})`
    : `Frame: child (${summary.frameUrl || "about:blank"}) name=${summary.frameName || "-"}`;
  lines.push(frameHeader);
  lines.push(
    [
      `readyState=${summary.readyState || "unknown"}`,
      `forms=${summary.forms.length}`,
      `inputs=${summary.inputs.length}`,
      `buttons=${summary.buttons.length}`,
      `iframes=${summary.iframeCount}`,
      `scripts=${summary.scriptCount}`,
      `links=${summary.linkCount}`,
      `appRoot=${summary.appRootDetected ? "yes" : "no"}`,
    ].join(", "),
  );

  if (summary.text) {
    lines.push(`Text: ${truncateContent(summary.text, MAX_TEXT_SNIPPET)}`);
  } else if (summary.htmlSnippet) {
    lines.push(`HTML snippet: ${summary.htmlSnippet}`);
  } else {
    lines.push("Text: (empty)");
  }

  if (summary.forms.length > 0) {
    lines.push(`Forms: ${summary.forms.map(summarizeField).join(" | ")}`);
  }
  if (summary.inputs.length > 0) {
    lines.push(`Inputs: ${summary.inputs.map(summarizeField).join(" | ")}`);
  }
  if (summary.buttons.length > 0) {
    lines.push(`Buttons: ${summary.buttons.map(summarizeField).join(" | ")}`);
  }

  return lines.join("\n");
}

async function captureFrameSummary(
  frame: import("playwright").Frame,
  isMainFrame: boolean,
): Promise<DomFrameSummary | undefined> {
  const frameUrl = frame.url();
  const frameName = frame.name();
  try {
    const data = await frame.evaluate(
      ({ maxFieldCount, maxHtmlLength }) => {
        const clean = (value: unknown, max = 120): string => {
          if (typeof value !== "string") return "";
          return value.replace(/\s+/g, " ").trim().slice(0, max);
        };

        const readLabel = (el: Element): string => {
          const id = (el as HTMLInputElement).id;
          if (!id) return "";
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          return clean(label?.textContent ?? "");
        };

        const toFieldSummary = (el: Element): DomFieldSummary => {
          const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
          const tag = node.tagName.toLowerCase();
          const type = "type" in node && typeof node.type === "string" ? clean(node.type, 40) : "";
          const id = "id" in node ? clean(node.id, 80) : "";
          const name = "name" in node ? clean(node.name, 80) : "";
          const placeholder = "placeholder" in node ? clean(node.placeholder, 120) : "";
          const ariaLabel = clean(node.getAttribute("aria-label") ?? "", 120);
          const label = clean(readLabel(node), 120) || ariaLabel;
          const text = clean((node as HTMLButtonElement).innerText ?? node.textContent ?? "", 120);
          return { tag, type, id, name, placeholder, label, text };
        };

        const forms = Array.from(document.querySelectorAll("form"))
          .slice(0, maxFieldCount)
          .map((form) => {
            const formElement = form as HTMLFormElement;
            return {
              tag: "form",
              id: clean(formElement.id, 80),
              name: clean(formElement.name, 80),
              type: clean(formElement.method || "get", 40),
              placeholder: clean(formElement.getAttribute("action") ?? "", 120),
              label: clean(formElement.getAttribute("aria-label") ?? "", 120),
              text: "",
            };
          });

        const inputs = Array.from(
          document.querySelectorAll("input,textarea,select"),
        )
          .slice(0, maxFieldCount)
          .map((input) => toFieldSummary(input));

        const buttons = Array.from(
          document.querySelectorAll("button,input[type=button],input[type=submit],input[type=reset]"),
        )
          .slice(0, maxFieldCount)
          .map((button) => toFieldSummary(button));

        const bodyText = clean(document.body?.innerText ?? "", 100_000);
        const htmlSnippet = clean(document.body?.innerHTML ?? "", maxHtmlLength);

        return {
          readyState: clean(document.readyState, 40),
          appRootDetected: Boolean(
            document.querySelector("#root, #app, [data-reactroot], [data-v-app], [ng-app]"),
          ),
          iframeCount: document.querySelectorAll("iframe").length,
          scriptCount: document.querySelectorAll("script").length,
          linkCount: document.querySelectorAll("a[href]").length,
          text: bodyText,
          htmlSnippet,
          forms,
          inputs,
          buttons,
        };
      },
      { maxFieldCount: MAX_FIELD_COUNT, maxHtmlLength: MAX_HTML_SNIPPET },
    );

    return {
      frameUrl,
      frameName,
      isMainFrame,
      readyState: data.readyState,
      appRootDetected: data.appRootDetected,
      iframeCount: data.iframeCount,
      scriptCount: data.scriptCount,
      linkCount: data.linkCount,
      text: data.text,
      htmlSnippet: data.htmlSnippet,
      forms: data.forms,
      inputs: data.inputs,
      buttons: data.buttons,
    };
  } catch {
    return undefined;
  }
}

async function captureDomSnapshot(page: import("playwright").Page): Promise<string> {
  const mainFrame = page.mainFrame();
  const frameSummaries: DomFrameSummary[] = [];

  const mainSummary = await captureFrameSummary(mainFrame, true);
  if (mainSummary) frameSummaries.push(mainSummary);

  for (const frame of page.frames()) {
    if (frame === mainFrame) continue;
    if (frameSummaries.length >= MAX_FRAME_COUNT) break;
    const summary = await captureFrameSummary(frame, false);
    if (!summary) continue;
    const hasSignal =
      summary.text.length > 0 ||
      summary.forms.length > 0 ||
      summary.inputs.length > 0 ||
      summary.buttons.length > 0;
    if (!hasSignal) continue;
    frameSummaries.push(summary);
  }

  if (frameSummaries.length === 0) return "(empty DOM snapshot)";

  return frameSummaries.map((summary) => formatFrameSummary(summary)).join("\n\n---\n\n");
}

function splitSelectorCandidates(selector: string): string[] {
  return selector
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractQuotedText(selector: string): string | undefined {
  const match = selector.match(/["']([^"']{2,})["']/);
  return match?.[1]?.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function hasAnyMatch(locator: import("playwright").Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function resolveActionLocator(
  page: import("playwright").Page,
  selector: string,
  actionType: "click" | "fill" | "select",
): Promise<import("playwright").Locator> {
  const direct = page.locator(selector).first();
  if (await hasAnyMatch(direct)) return direct;

  for (const candidate of splitSelectorCandidates(selector)) {
    const locator = page.locator(candidate).first();
    if (await hasAnyMatch(locator)) return locator;
  }

  const lowered = selector.toLowerCase();

  if (actionType === "fill") {
    if (lowered.includes("pass")) {
      const password = page.locator("input[type='password']").first();
      if (await hasAnyMatch(password)) return password;
    }
    if (lowered.includes("user") || lowered.includes("email") || lowered.includes("login")) {
      const userField = page.locator("input[type='text'],input[type='email'],input:not([type]),textarea").first();
      if (await hasAnyMatch(userField)) return userField;
    }
    const genericField = page.locator("input,textarea").first();
    if (await hasAnyMatch(genericField)) return genericField;
  }

  if (actionType === "select") {
    const selectField = page.locator("select").first();
    if (await hasAnyMatch(selectField)) return selectField;
  }

  if (actionType === "click") {
    const quoted = extractQuotedText(selector);
    if (quoted) {
      const buttonByRole = page.getByRole("button", { name: new RegExp(escapeRegex(quoted), "i") }).first();
      if (await hasAnyMatch(buttonByRole)) return buttonByRole;
    }
    const submit = page.locator("button[type='submit'],input[type='submit']").first();
    if (await hasAnyMatch(submit)) return submit;
    const generic = page.locator("button,[role='button'],a[role='button']").first();
    if (await hasAnyMatch(generic)) return generic;
  }

  return direct;
}

async function performClick(
  page: import("playwright").Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const locator = await resolveActionLocator(page, selector, "click");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
    return;
  } catch (firstError) {
    try {
      await locator.click({ timeout: Math.min(2_500, timeoutMs), force: true });
      return;
    } catch {
      const handle = await locator.elementHandle({ timeout: Math.min(2_500, timeoutMs) }).catch(() => null);
      if (handle) {
        try {
          await handle.evaluate((el) => (el as HTMLElement).click());
          await handle.dispose();
          return;
        } catch {
          await handle.dispose().catch(() => {});
        }
      }
      throw firstError;
    }
  }
}

async function performFill(
  page: import("playwright").Page,
  selector: string,
  value: string,
  timeoutMs: number,
): Promise<void> {
  const locator = await resolveActionLocator(page, selector, "fill");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.fill(value, { timeout: timeoutMs });
    return;
  } catch (firstError) {
    try {
      await locator.click({ timeout: Math.min(2_500, timeoutMs), force: true });
      await locator.press("Control+A").catch(() => {});
      await locator.type(value, { timeout: timeoutMs, delay: 15 });
      return;
    } catch {
      throw firstError;
    }
  }
}

async function performSelect(
  page: import("playwright").Page,
  selector: string,
  value: string,
  timeoutMs: number,
): Promise<void> {
  const locator = await resolveActionLocator(page, selector, "select");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.selectOption(value, { timeout: timeoutMs });
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
        await waitForPageHydration(page, waitFor);
        const title = await page.title();
        const snapshot = await captureDomSnapshot(page);
        return { content: truncateContent(snapshot), title, url: page.url() };
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
        await waitForPageHydration(page);
        for (const action of actions) {
          try {
            switch (action.type) {
              case "click":
                await performClick(page, action.selector, action.timeout ?? 10_000);
                break;
              case "fill":
                await performFill(page, action.selector, action.value, action.timeout ?? 10_000);
                break;
              case "select":
                await performSelect(page, action.selector, action.value, action.timeout ?? 10_000);
                break;
              case "wait":
                if (action.selector) {
                  await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10_000 }).catch(() => {});
                } else {
                  await page.waitForTimeout(action.timeout ?? 3000);
                }
                break;
            }
          } catch (actionError) {
            throw new Error(
              `Action ${action.type} failed for selector "${"selector" in action ? action.selector ?? "" : ""}": ${errorMessage(actionError)}`,
            );
          }
        }
        await waitForPageHydration(page);
        const parts: string[] = [];
        const mainSnapshot = await captureDomSnapshot(page);
        parts.push(truncateContent(mainSnapshot, 4000));
        if (followUpUrls) {
          for (const followUrl of followUpUrls) {
            try {
              const nextUrl = validateHttpUrl(followUrl);
              await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
              await waitForPageHydration(page);
              const followSnapshot = await captureDomSnapshot(page);
              parts.push(`\n--- ${nextUrl} ---\n${truncateContent(followSnapshot, 4000)}`);
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
