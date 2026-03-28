import { test, expect, describe } from "bun:test";
import type { BrowseResult, SearchResult, PageAction } from "./browser";

describe("browser types", () => {
  test("BrowseResult has required fields", () => {
    const result: BrowseResult = { content: "hello", title: "Test", url: "https://x.com" };
    expect(result.content).toBe("hello");
    expect(result.title).toBe("Test");
    expect(result.url).toBe("https://x.com");
  });

  test("SearchResult has required fields", () => {
    const result: SearchResult = { title: "Bun", url: "https://bun.sh", snippet: "Fast JS runtime" };
    expect(result.title).toBe("Bun");
  });

  test("PageAction types are valid", () => {
    const actions: PageAction[] = [
      { type: "click", selector: "#btn", timeout: 1500 },
      { type: "fill", selector: "#email", value: "a@b.com", timeout: 1500 },
      { type: "select", selector: "#country", value: "AR", timeout: 1500 },
      { type: "wait", timeout: 1000 },
      { type: "wait", selector: "#loaded" },
    ];
    expect(actions).toHaveLength(5);
  });
});

describe("content truncation", () => {
  test("truncateContent caps at limit", async () => {
    const { truncateContent } = await import("./browser");
    const long = "x".repeat(10000);
    const result = truncateContent(long, 8000);
    expect(result.length).toBeLessThanOrEqual(8000);
  });

  test("truncateContent preserves short content", async () => {
    const { truncateContent } = await import("./browser");
    const short = "hello world";
    expect(truncateContent(short, 8000)).toBe(short);
  });
});

describe("search html parsing", () => {
  test("parseDuckDuckGoHtml extracts title/url/snippet and resolves redirect url", async () => {
    const { parseDuckDuckGoHtml } = await import("./browser");
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F">Bun &amp; Runtime</a>
        <a class="result__snippet">Fast JavaScript runtime &amp; toolkit.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://github.com/oven-sh/bun/releases/latest">Bun Releases</a>
        <div class="result__snippet">Latest Bun release information.</div>
      </div>
    `;

    const results = parseDuckDuckGoHtml(html, 3);

    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("Bun & Runtime");
    expect(results[0]?.url).toBe("https://bun.sh/");
    expect(results[0]?.snippet).toContain("Fast JavaScript runtime");
    expect(results[1]?.url).toContain("github.com/oven-sh/bun/releases/latest");
  });
});

describe("browseUrl error handling", () => {
  test("returns error BrowseResult on invalid URL without launching browser", async () => {
    const { browseUrl } = await import("./browser");
    const result = await browseUrl("not-a-url");
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
    expect(result.title).toBe("Error");
    expect(result.content).toContain("Invalid URL");
  });
});

describe("searchWeb error handling", () => {
  test("returns error result when Playwright is not installed", async () => {
    const { searchWeb } = await import("./browser");
    const results = await searchWeb("test query");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("interactWithPage error handling", () => {
  test("returns error BrowseResult on invalid URL without launching browser", async () => {
    const { interactWithPage } = await import("./browser");
    const result = await interactWithPage("not-a-url", []);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
    expect(result.title).toBe("Error");
    expect(result.content).toContain("Invalid URL");
  });
});
