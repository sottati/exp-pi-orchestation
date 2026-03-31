import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { BrowseResult, SearchResult } from "./browser";

// --- Type checks ---

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
    expect(result.url).toBe("https://bun.sh");
    expect(result.snippet).toBe("Fast JS runtime");
  });
});

// --- browseUrl ---

describe("browseUrl", () => {
  test("returns error BrowseResult on invalid URL without making HTTP call", async () => {
    const { browseUrl } = await import("./browser");
    const result = await browseUrl("not-a-url");
    expect(result.title).toBe("Error");
    expect(result.content).toContain("Invalid URL");
  });

  test("returns error BrowseResult on unsupported protocol", async () => {
    const { browseUrl } = await import("./browser");
    const result = await browseUrl("ftp://example.com/file");
    expect(result.title).toBe("Error");
    expect(result.content).toContain("Unsupported protocol");
  });

  test("calls browse service and maps markdown to content", async () => {
    const { browseUrl } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ markdown: "# Hello", title: "Test", url: "https://example.com" }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    try {
      const result = await browseUrl("https://example.com");
      expect(result.content).toBe("# Hello");
      expect(result.title).toBe("Test");
      expect(result.url).toBe("https://example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns error BrowseResult when browse service returns error field", async () => {
    const { browseUrl } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Crawl4AI failed" }), { status: 500 }),
      )) as unknown as typeof fetch;
    try {
      const result = await browseUrl("https://example.com");
      expect(result.title).toBe("Error");
      expect(result.content).toContain("Crawl4AI failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns explicit timeout message on aborted browse request", async () => {
    const { browseUrl } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch;
    try {
      const result = await browseUrl("https://example.com");
      expect(result.title).toBe("Error");
      expect(result.content).toContain("timed out");
      expect(result.content).toContain("/browse");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- searchWeb ---

describe("searchWeb", () => {
  test("returns error result when SearXNG is unreachable", async () => {
    const { searchWeb } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    try {
      const results = await searchWeb("test query");
      expect(Array.isArray(results)).toBe(true);
      expect(results[0]?.title).toBe("Search Error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns parsed results from SearXNG JSON response", async () => {
    const { searchWeb } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              { title: "Bun", url: "https://bun.sh", content: "Fast JS runtime" },
              { title: "Node", url: "https://nodejs.org", content: "JS runtime" },
            ],
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    try {
      const results = await searchWeb("bun runtime", 2);
      expect(results).toHaveLength(2);
      expect(results[0]?.title).toBe("Bun");
      expect(results[0]?.url).toBe("https://bun.sh");
      expect(results[0]?.snippet).toBe("Fast JS runtime");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects maxResults cap", async () => {
    const { searchWeb } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: Array.from({ length: 10 }, (_, i) => ({
              title: `Result ${i}`,
              url: `https://example.com/${i}`,
              content: `Snippet ${i}`,
            })),
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    try {
      const results = await searchWeb("query", 3);
      expect(results).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- interactWithPage ---

describe("interactWithPage", () => {
  test("returns error BrowseResult on invalid URL", async () => {
    const { interactWithPage } = await import("./browser");
    const result = await interactWithPage("not-a-url", "click the button");
    expect(result.title).toBe("Error");
    expect(result.content).toContain("Invalid URL");
  });

  test("calls interact service and maps result to content", async () => {
    const { interactWithPage } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result: "Logged in successfully",
            final_url: "https://example.com/dashboard",
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    try {
      const result = await interactWithPage("https://example.com", "log in");
      expect(result.content).toBe("Logged in successfully");
      expect(result.url).toBe("https://example.com/dashboard");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("includes HTTP status and body snippet when interact service fails", async () => {
    const { interactWithPage } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("browser-use crashed at step 2", { status: 500 }))) as unknown as typeof fetch;
    try {
      const result = await interactWithPage("https://example.com", "log in");
      expect(result.title).toBe("Error");
      expect(result.content).toContain("HTTP 500");
      expect(result.content).toContain("browser-use crashed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns explicit timeout message on aborted interact request", async () => {
    const { interactWithPage } = await import("./browser");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch;
    try {
      const result = await interactWithPage("https://example.com", "log in");
      expect(result.title).toBe("Error");
      expect(result.content).toContain("timed out");
      expect(result.content).toContain("/interact");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
