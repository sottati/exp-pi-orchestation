import { test, expect, describe } from "bun:test";
import { MemoryClient } from "./memory-client";
import type { MemoryResult } from "./memory-client";

// Helper to stub globalThis.fetch and restore it after a test body runs.
async function withFetch<T>(
  stub: typeof globalThis.fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// save()
// ---------------------------------------------------------------------------

describe("MemoryClient.save()", () => {
  test("success: POSTs /observations with correct body and returns id", async () => {
    const capturedRequests: { url: string; init: RequestInit }[] = [];

    const result = await withFetch(
      ((url: string, init: RequestInit) => {
        capturedRequests.push({ url, init });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 42, title: "t", content: "c", type: "decision" }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.save({ type: "decision", title: "My title", content: "My content" });
      },
    );

    expect(result).toBe(42);
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0]!;
    expect(req.url).toBe("http://localhost:7437/observations");
    expect(req.init.method).toBe("POST");
    const body = JSON.parse(req.init.body as string) as Record<string, unknown>;
    expect(body.session_id).toBe("test-session");
    expect(body.type).toBe("decision");
    expect(body.title).toBe("My title");
    expect(body.content).toBe("My content");
    expect(body.scope).toBe("project");
  });

  test("HTTP error (4xx/5xx): returns undefined, does not throw", async () => {
    const result = await withFetch(
      (() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 }))) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.save({ type: "bug", title: "oops", content: "it broke" });
      },
    );

    expect(result).toBeUndefined();
  });

  test("network error (fetch throws): returns undefined, does not throw", async () => {
    const result = await withFetch(
      (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.save({ type: "pattern", title: "p", content: "q" });
      },
    );

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe("MemoryClient.search()", () => {
  test("success: GETs /search with correct query params and returns mapped MemoryResult[]", async () => {
    const capturedUrls: string[] = [];
    const fakeResults: MemoryResult[] = [
      { id: 1, title: "Decision A", content: "content A", type: "decision" },
      { id: 2, title: "Pattern B", content: "content B", type: "pattern" },
    ];

    const results = await withFetch(
      ((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve(new Response(JSON.stringify(fakeResults), { status: 200 }));
      }) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.search("my query", 5);
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe(1);
    expect(results[0]?.title).toBe("Decision A");
    expect(results[0]?.content).toBe("content A");
    expect(results[0]?.type).toBe("decision");
    expect(capturedUrls[0]).toContain("/search");
    expect(capturedUrls[0]).toContain("q=my%20query");
    expect(capturedUrls[0]).toContain("limit=5");
  });

  test("HTTP error: returns [], does not throw", async () => {
    const results = await withFetch(
      (() =>
        Promise.resolve(new Response("Not Found", { status: 404 }))) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.search("anything");
      },
    );

    expect(results).toEqual([]);
  });

  test("network error (fetch throws): returns [], does not throw", async () => {
    const results = await withFetch(
      (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://localhost:7437", "test-session");
        return client.search("anything");
      },
    );

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// constructor overrides
// ---------------------------------------------------------------------------

describe("MemoryClient constructor", () => {
  test("custom baseUrl and sessionId are used in requests", async () => {
    const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];

    await withFetch(
      ((url: string, init: RequestInit) => {
        capturedRequests.push({
          url,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 99 }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
      async () => {
        const client = new MemoryClient("http://custom-host:9000", "custom-session");
        await client.save({ type: "architecture", title: "t", content: "c" });
      },
    );

    expect(capturedRequests[0]?.url).toBe("http://custom-host:9000/observations");
    expect(capturedRequests[0]?.body.session_id).toBe("custom-session");
  });

  test("default baseUrl is read from ENGRAM_URL env var", async () => {
    const capturedUrls: string[] = [];
    const origEngramUrl = process.env.ENGRAM_URL;
    process.env.ENGRAM_URL = "http://envhost:1234";

    try {
      await withFetch(
        ((url: string, init: RequestInit) => {
          capturedUrls.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ id: 7 }), { status: 200 }),
          );
        }) as unknown as typeof fetch,
        async () => {
          // No constructor args — should pick up ENGRAM_URL
          const client = new MemoryClient();
          await client.save({ type: "preference", title: "t", content: "c" });
        },
      );
    } finally {
      if (origEngramUrl === undefined) {
        delete process.env.ENGRAM_URL;
      } else {
        process.env.ENGRAM_URL = origEngramUrl;
      }
    }

    expect(capturedUrls[0]).toStartWith("http://envhost:1234");
  });
});
