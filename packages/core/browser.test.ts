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
      { type: "click", selector: "#btn" },
      { type: "fill", selector: "#email", value: "a@b.com" },
      { type: "select", selector: "#country", value: "AR" },
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

describe("browseUrl error handling", () => {
  test("returns error BrowseResult when Playwright is not installed", async () => {
    const { browseUrl } = await import("./browser");
    const result = await browseUrl("https://example.com");
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
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
  test("returns error BrowseResult when Playwright is not installed", async () => {
    const { interactWithPage } = await import("./browser");
    const result = await interactWithPage("https://example.com", []);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("url");
  });
});
