import { errorMessage } from "./errors";

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

export async function launchAndRun<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const pw = await getPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function browseUrl(url: string, waitFor?: string): Promise<BrowseResult> {
  try {
    return await launchAndRun(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
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
    return { content: `Error browsing ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}

export async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const capped = Math.min(Math.max(maxResults, 1), 10);
  try {
    return await launchAndRun(async (page) => {
      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await page.waitForSelector("[data-result]", { timeout: 10_000 }).catch(() => {});
      const results = await page.evaluate((max: number) => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        const resultElements = document.querySelectorAll("[data-result]");
        for (let i = 0; i < Math.min(resultElements.length, max); i++) {
          const el = resultElements[i]!;
          const a = el.querySelector("a[href]");
          const snippetEl = el.querySelector("[data-result] .result__snippet, .result__body");
          items.push({
            title: a?.textContent?.trim() ?? "",
            url: a?.getAttribute("href") ?? "",
            snippet: snippetEl?.textContent?.trim() ?? el.textContent?.trim()?.slice(0, 200) ?? "",
          });
        }
        return items;
      }, capped);
      return results;
    });
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
    return await launchAndRun(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
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
            await page.goto(followUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
            const followContent = await page.evaluate(() => document.body?.innerText ?? "");
            parts.push(`\n--- ${followUrl} ---\n${truncateContent(followContent, 4000)}`);
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
    return { content: `Error interacting with ${url}: ${errorMessage(err)}`, title: "Error", url };
  }
}
