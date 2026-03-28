# Web Exploring Stack Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DuckDuckGo HTML scraping and Playwright DOM snapshots with SearXNG (direct HTTP from TS), Crawl4AI (Python microservice for browse), and browser-use with LLM (Python microservice for autonomous page interaction).

**Architecture:** TypeScript calls SearXNG REST API directly for `search_web`. For `browse_url` and `interact_page`, TS calls a FastAPI Python microservice at `BROWSE_SERVICE_URL`. The Python service internally uses Crawl4AI (Playwright-backed) for browse and browser-use (LLM-driven Playwright) for interaction. All three services orchestrated via Docker Compose.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, Crawl4AI, browser-use, langchain-openai, pytest; TypeScript/Bun; SearXNG Docker image; Docker Compose.

---

## File Map

| File | Action |
|---|---|
| `services/browse-service/requirements.txt` | Create |
| `services/browse-service/Dockerfile` | Create |
| `services/browse-service/main.py` | Create |
| `services/browse-service/crawler.py` | Create |
| `services/browse-service/interactor.py` | Create |
| `services/browse-service/tests/__init__.py` | Create |
| `services/browse-service/tests/test_main.py` | Create |
| `services/searxng/settings.yml` | Create |
| `docker-compose.yml` | Create |
| `packages/core/browser.ts` | Rewrite (replace 3 functions, remove all Playwright infra) |
| `packages/core/browser.test.ts` | Rewrite (remove DDG/PageAction tests, add HTTP mock tests) |
| `packages/core/browser-node-bridge.mjs` | Delete |
| `packages/core/explorer-tools.ts` | Modify (`interact_page` new interface, remove `redactActions`) |
| `packages/core/explorer-tools.test.ts` | Modify (remove `redactActions` test, update `interact_page` schema test) |
| `CLAUDE.md` | Update (prereqs, Docker instructions) |
| `README.md` | Update |
| `AGENTS.md` | Update |

---

### Task 1: Python Service Foundation

**Files:**
- Create: `services/browse-service/requirements.txt`
- Create: `services/browse-service/Dockerfile`
- Create: `services/browse-service/main.py`
- Create: `services/browse-service/tests/__init__.py`
- Create: `services/browse-service/tests/test_main.py`

- [ ] **Step 1: Write the failing test**

Create `services/browse-service/tests/__init__.py` (empty):
```python
```

Create `services/browse-service/tests/test_main.py`:
```python
import pytest
from fastapi.testclient import TestClient


def get_client():
    from main import app
    return TestClient(app)


def test_health():
    client = get_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/browse-service && python -m pytest tests/test_main.py::test_health -v
```

Expected: `ERROR` — `ModuleNotFoundError: No module named 'main'` (nothing exists yet).

- [ ] **Step 3: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
crawl4ai>=0.4.0
browser-use>=0.1.40
langchain-openai>=0.3.0
pydantic>=2.0.0
pytest>=8.0.0
httpx>=0.27.0
```

- [ ] **Step 4: Create main.py with /health only**

Create `services/browse-service/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="pi-browse-service")


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 5: Install deps and run test to verify it passes**

```bash
cd services/browse-service && pip install -r requirements.txt
python -m pytest tests/test_main.py::test_health -v
```

Expected: `PASSED`

- [ ] **Step 6: Create Dockerfile**

Create `services/browse-service/Dockerfile`:
```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Chromium + system deps (used by both Crawl4AI and browser-use)
RUN python -m playwright install chromium --with-deps

COPY . .

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
```

- [ ] **Step 7: Commit**

```bash
git add services/browse-service/
git commit -m "feat(browse-service): Python service foundation with /health endpoint"
```

---

### Task 2: Crawl4AI Browse Endpoint

**Files:**
- Create: `services/browse-service/crawler.py`
- Modify: `services/browse-service/main.py` (add `/browse` route)
- Modify: `services/browse-service/tests/test_main.py` (add browse tests)

- [ ] **Step 1: Write the failing tests**

Append to `services/browse-service/tests/test_main.py`:
```python
from unittest.mock import AsyncMock, patch


def test_browse_success():
    client = get_client()
    mock_result = {
        "markdown": "# Hello World\nSome content here.",
        "title": "Hello World",
        "url": "https://example.com",
    }
    with patch("main.crawl_url", new=AsyncMock(return_value=mock_result)):
        response = client.post("/browse", json={"url": "https://example.com"})
    assert response.status_code == 200
    data = response.json()
    assert data["markdown"] == "# Hello World\nSome content here."
    assert data["title"] == "Hello World"
    assert data["url"] == "https://example.com"


def test_browse_with_wait_for():
    client = get_client()
    mock_result = {"markdown": "content", "title": "Page", "url": "https://example.com"}
    with patch("main.crawl_url", new=AsyncMock(return_value=mock_result)):
        response = client.post("/browse", json={"url": "https://example.com", "wait_for": "#main"})
    assert response.status_code == 200


def test_browse_propagates_error():
    client = get_client()
    with patch("main.crawl_url", new=AsyncMock(side_effect=RuntimeError("Crawl failed"))):
        response = client.post("/browse", json={"url": "https://example.com"})
    assert response.status_code == 500
    assert "Crawl failed" in response.json()["error"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd services/browse-service && python -m pytest tests/test_main.py::test_browse_success tests/test_main.py::test_browse_with_wait_for tests/test_main.py::test_browse_propagates_error -v
```

Expected: `FAILED` — `404 Not Found` (no `/browse` route yet).

- [ ] **Step 3: Create crawler.py**

Create `services/browse-service/crawler.py`:
```python
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator


async def crawl_url(url: str, wait_for: str | None = None) -> dict:
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        wait_for=wait_for,
        markdown_generator=DefaultMarkdownGenerator(
            content_filter=PruningContentFilter()
        ),
    )
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=url, config=config)
    if not result.success:
        raise RuntimeError(result.error_message or f"Crawl4AI failed for {url}")
    markdown = ""
    if result.markdown:
        markdown = result.markdown.fit_markdown or result.markdown.raw_markdown or ""
    return {
        "markdown": markdown,
        "title": (result.metadata or {}).get("title", ""),
        "url": result.url or url,
    }
```

- [ ] **Step 4: Add /browse route to main.py**

Replace `services/browse-service/main.py` with:
```python
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from crawler import crawl_url
from interactor import interact_page as interact_task

app = FastAPI(title="pi-browse-service")


class BrowseRequest(BaseModel):
    url: str
    wait_for: str | None = None


class InteractRequest(BaseModel):
    url: str
    task: str


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/browse")
async def browse(req: BrowseRequest):
    try:
        result = await crawl_url(req.url, req.wait_for)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/interact")
async def interact(req: InteractRequest):
    try:
        result = await interact_task(req.url, req.task)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
```

Note: `main.py` already imports `interact_page` from `interactor` — create a stub `interactor.py` so the import doesn't fail:

Create `services/browse-service/interactor.py` (stub):
```python
async def interact_page(url: str, task: str) -> dict:
    raise NotImplementedError("browser-use interactor not yet implemented")
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd services/browse-service && python -m pytest tests/test_main.py -v
```

Expected: All 4 tests (`test_health`, `test_browse_success`, `test_browse_with_wait_for`, `test_browse_propagates_error`) `PASSED`.

- [ ] **Step 6: Commit**

```bash
git add services/browse-service/crawler.py services/browse-service/interactor.py services/browse-service/main.py services/browse-service/tests/test_main.py
git commit -m "feat(browse-service): add /browse endpoint with Crawl4AI"
```

---

### Task 3: browser-use Interact Endpoint

**Files:**
- Modify: `services/browse-service/interactor.py` (replace stub with real implementation)
- Modify: `services/browse-service/tests/test_main.py` (add interact tests)

- [ ] **Step 1: Write the failing tests**

Append to `services/browse-service/tests/test_main.py`:
```python
def test_interact_success():
    client = get_client()
    mock_result = {
        "result": "Successfully logged in and navigated to reports.",
        "final_url": "https://example.com/reports",
    }
    with patch("main.interact_task", new=AsyncMock(return_value=mock_result)):
        response = client.post("/interact", json={
            "url": "https://example.com",
            "task": "Log in and go to reports",
        })
    assert response.status_code == 200
    data = response.json()
    assert data["result"] == "Successfully logged in and navigated to reports."
    assert data["final_url"] == "https://example.com/reports"


def test_interact_propagates_error():
    client = get_client()
    with patch("main.interact_task", new=AsyncMock(side_effect=RuntimeError("browser-use failed"))):
        response = client.post("/interact", json={
            "url": "https://example.com",
            "task": "do something",
        })
    assert response.status_code == 500
    assert "browser-use failed" in response.json()["error"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd services/browse-service && python -m pytest tests/test_main.py::test_interact_success tests/test_main.py::test_interact_propagates_error -v
```

Expected: `FAILED` — stub raises `NotImplementedError` so error propagates as 500, but the success case fails because the stub raises instead of returning.

- [ ] **Step 3: Implement interactor.py**

Replace `services/browse-service/interactor.py` with:
```python
import os

from langchain_openai import ChatOpenAI
from browser_use import Agent

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
# Format: "openrouter/google/gemini-3.1-flash-lite-preview"
# LangChain ChatOpenAI needs model without "openrouter/" prefix
BROWSE_LLM_MODEL = os.environ.get(
    "BROWSE_LLM_MODEL",
    "openrouter/google/gemini-3.1-flash-lite-preview",
)


def _build_llm() -> ChatOpenAI:
    model_name = BROWSE_LLM_MODEL.removeprefix("openrouter/")
    return ChatOpenAI(
        model=model_name,
        api_key=OPENROUTER_API_KEY or "dummy",
        base_url="https://openrouter.ai/api/v1",
    )


async def interact_page(url: str, task: str) -> dict:
    llm = _build_llm()
    agent = Agent(
        task=f"Navigate to {url} and then: {task}",
        llm=llm,
    )
    history = await agent.run(max_steps=20)
    final_result = history.final_result() or "Task completed"
    urls = history.urls() if hasattr(history, "urls") else []
    final_url = urls[-1] if urls else url
    return {
        "result": final_result,
        "final_url": final_url,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd services/browse-service && python -m pytest tests/test_main.py -v
```

Expected: All 6 tests `PASSED`. The `test_interact_*` tests mock `main.interact_task` so no real browser-use call is made.

- [ ] **Step 5: Commit**

```bash
git add services/browse-service/interactor.py services/browse-service/tests/test_main.py
git commit -m "feat(browse-service): add /interact endpoint with browser-use"
```

---

### Task 4: SearXNG Config + Docker Compose

**Files:**
- Create: `services/searxng/settings.yml`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create SearXNG settings.yml**

Create `services/searxng/settings.yml`:
```yaml
use_default_settings: true

general:
  instance_name: "pi-searxng"
  debug: false

search:
  safe_search: 0
  formats:
    - html
    - json

server:
  secret_key: "pi-searxng-local-dev-secret-key-change-in-prod"
  bind_address: "0.0.0.0"
  port: 8080
  http_protocol_version: "1.0"
  method: "GET"

ui:
  default_theme: simple

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: bing
    engine: bing
    shortcut: b
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: d
    disabled: false
```

- [ ] **Step 2: Create docker-compose.yml**

Create `docker-compose.yml` at project root:
```yaml
services:
  pi-backend:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      SEARXNG_URL: http://searxng:8080
      BROWSE_SERVICE_URL: http://pi-browse-service:8001
    depends_on:
      searxng:
        condition: service_healthy
      pi-browse-service:
        condition: service_healthy
    env_file:
      - .env

  pi-browse-service:
    build:
      context: ./services/browse-service
    ports:
      - "8001:8001"
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      BROWSE_LLM_MODEL: ${BROWSE_LLM_MODEL:-openrouter/google/gemini-3.1-flash-lite-preview}
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')"]
      interval: 15s
      timeout: 5s
      start_period: 90s
      retries: 5

  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    volumes:
      - ./services/searxng:/etc/searxng:ro
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 5s
      start_period: 30s
      retries: 5
```

Note: This assumes a `Dockerfile` exists at the project root for the Bun backend (the existing one if present, or it can be added later). The `pi-browse-service` can be started independently: `docker-compose up searxng pi-browse-service`.

- [ ] **Step 3: Verify SearXNG starts locally**

```bash
docker-compose up searxng -d
# Wait ~10s then test
curl "http://localhost:8080/search?q=bun+javascript&format=json" | head -c 200
```

Expected: JSON response with `results` array.

```bash
docker-compose down
```

- [ ] **Step 4: Commit**

```bash
git add services/searxng/settings.yml docker-compose.yml
git commit -m "feat: add SearXNG config and Docker Compose"
```

---

### Task 5: TypeScript browser.ts Rewrite (TDD)

**Files:**
- Modify: `packages/core/browser.test.ts` (rewrite — remove DDG/PageAction tests, add HTTP mock tests)
- Modify: `packages/core/browser.ts` (rewrite — replace 3 functions, remove all Playwright infra)

- [ ] **Step 1: Rewrite browser.test.ts with new expectations**

Replace `packages/core/browser.test.ts` entirely:
```typescript
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
      )) as typeof fetch;
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
      )) as typeof fetch;
    try {
      const result = await browseUrl("https://example.com");
      expect(result.title).toBe("Error");
      expect(result.content).toContain("Crawl4AI failed");
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
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
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
      )) as typeof fetch;
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
      )) as typeof fetch;
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
      )) as typeof fetch;
    try {
      const result = await interactWithPage("https://example.com", "log in");
      expect(result.content).toBe("Logged in successfully");
      expect(result.url).toBe("https://example.com/dashboard");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/core/browser.test.ts
```

Expected: Several `FAILED` — the `searchWeb` and `browseUrl` mock tests fail because current `browser.ts` does not call the mock-able fetch for these paths; old DDG/PageAction tests no longer exist so those are gone.

- [ ] **Step 3: Rewrite browser.ts**

Replace `packages/core/browser.ts` entirely:
```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/core/browser.test.ts
```

Expected: All tests `PASSED`.

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
bun test
```

Expected: All tests pass. `explorer-tools.ts` still has `import type { PageAction } from "./browser"` — this is a TYPE-only import erased at runtime by Bun's transpiler, so `bun test` is unaffected. Do NOT run `bun run typecheck` here — it will fail because `PageAction` no longer exists in `browser.ts`. Typecheck is run after Task 6 fixes `explorer-tools.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/browser.ts packages/core/browser.test.ts
git commit -m "feat(browser): replace Playwright/DuckDuckGo stack with SearXNG+Python service HTTP calls"
```

---

### Task 6: Update explorer-tools.ts (New interact_page Interface)

**Files:**
- Modify: `packages/core/explorer-tools.test.ts`
- Modify: `packages/core/explorer-tools.ts`

- [ ] **Step 1: Rewrite explorer-tools.test.ts**

Replace `packages/core/explorer-tools.test.ts` entirely:
```typescript
import { test, expect, describe } from "bun:test";
import { createExplorerToolEntries } from "./explorer-tools";

describe("createExplorerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createExplorerToolEntries({});
    const names = entries.map(e => e.name);
    expect(names).toEqual(["browse_url", "search_web", "interact_page"]);
  });

  test("browse_url and search_web have allow permission", () => {
    const entries = createExplorerToolEntries({});
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["browse_url"]).toBe("allow");
    expect(perms["search_web"]).toBe("allow");
  });

  test("interact_page has hitl permission", () => {
    const entries = createExplorerToolEntries({});
    const tool = entries.find(e => e.name === "interact_page")!;
    expect(tool.defaultPermission).toBe("hitl");
  });

  test("all tools have source local and are available", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });

  test("all tools have description, parameters, and execute function", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });

  test("interact_page parameters have url and task (not actions)", () => {
    const entries = createExplorerToolEntries({});
    const interactTool = entries.find(e => e.name === "interact_page")!;
    const schema = interactTool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("url");
    expect(schema.properties).toHaveProperty("task");
    expect(schema.properties).not.toHaveProperty("actions");
    expect(schema.properties).not.toHaveProperty("followUpUrls");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/core/explorer-tools.test.ts
```

Expected: `FAILED` for the `interact_page parameters` test — current schema has `actions` not `task`.

- [ ] **Step 3: Rewrite explorer-tools.ts**

Replace `packages/core/explorer-tools.ts` entirely:
```typescript
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";

export interface ExplorerToolOptions {
  credentialStore?: CredentialStore;
}

async function resolveTaskCredentialPlaceholders(
  task: string,
  url: string,
  credentialStore?: CredentialStore,
): Promise<string> {
  if (!credentialStore?.enabled) return task;
  let domain: string;
  try {
    domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return task;
  }
  const creds = await credentialStore.get(domain);
  if (!creds) return task;
  return task.replace(/\{\{credential:([^}]+)\}\}/g, (_match, key: string) => {
    return creds[key] ?? _match;
  });
}

export function createExplorerToolEntries(opts: ExplorerToolOptions): ToolEntry[] {
  const { credentialStore } = opts;

  const browseUrl: ToolEntry = {
    name: "browse_url",
    source: "local",
    description: "Navigate to a URL and extract clean markdown content. Returns the page title and final URL.",
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
    description: "Search the web using SearXNG. Returns a list of results with title, URL, and snippet.",
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
    description: "Autonomously interact with a web page using a natural language task description. browser-use navigates, clicks, fills forms, and performs actions to complete the task. Supports {{credential:fieldname}} placeholders for secure credential injection.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      task: Type.String({ description: "Natural language description of what to accomplish. E.g. 'Log in with username {{credential:username}} and navigate to the reports section'." }),
    }),
    execute: async (_toolCallId, params) => {
      const { interactWithPage } = await import("./browser");
      const url = params.url as string;
      const task = await resolveTaskCredentialPlaceholders(
        params.task as string,
        url,
        credentialStore,
      );
      const result = await interactWithPage(url, task);
      if (result.title === "Error" || result.content.startsWith("Error interacting with ")) {
        throw new Error(result.content);
      }
      return {
        content: [{ type: "text" as const, text: `# Interaction Complete\nURL: ${result.url}\n\n${result.content}` }],
        details: { url: result.url },
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [browseUrl, searchWeb, interactPage];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/core/explorer-tools.test.ts
```

Expected: All 6 tests `PASSED`.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: All tests pass. Note: `packages/core/agents-v2.test.ts` may test agent tool lists — if it references `redactActions` or the old `interact_page` schema, fix inline. The test should not reference `redactActions` as it's an internal function not exported from the agent module.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: No new errors in `browser.ts` or `explorer-tools.ts`. Pre-existing errors in `apps/web/runtime-context.tsx` and `apps/web/sidebar.tsx` are unrelated to this work.

- [ ] **Step 7: Commit**

```bash
git add packages/core/explorer-tools.ts packages/core/explorer-tools.test.ts
git commit -m "feat(explorer-tools): replace actions-based interact_page with task-based browser-use interface"
```

---

### Task 7: Delete Node Bridge + Update Docs

**Files:**
- Delete: `packages/core/browser-node-bridge.mjs`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Delete browser-node-bridge.mjs**

```bash
git rm packages/core/browser-node-bridge.mjs
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
bun test packages/core/browser.test.ts packages/core/explorer-tools.test.ts
```

Expected: All `PASSED` — `browser.ts` no longer references the bridge file.

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, find the existing "Explorer prerequisite" section and replace it with:

```markdown
Explorer prerequisite:

- Start supporting services before running explorer agent or smoke test:
  - `docker-compose up searxng pi-browse-service -d`
  - Or run SearXNG manually: `docker run -p 8080:8080 -v ./services/searxng:/etc/searxng searxng/searxng:latest`
  - Or run Python service manually: `cd services/browse-service && uvicorn main:app --port 8001`
- Set env vars for local dev (no Docker):
  - `SEARXNG_URL=http://localhost:8080` (default)
  - `BROWSE_SERVICE_URL=http://localhost:8001` (default)
- Python service requires `OPENROUTER_API_KEY` for `interact_page` (browser-use LLM)
- `BROWSE_LLM_MODEL` overrides the LLM model used by browser-use (default: `openrouter/google/gemini-3.1-flash-lite-preview`)
```

Also update the "Browser wrapper" and "Browser Node bridge" lines in the Project Context section:

Find:
```
- Browser wrapper: `packages/core/browser.ts` (`browseUrl`/`interactWithPage` use Playwright with SPA hydration waits + DOM snapshots including forms/inputs/buttons/iframes + heuristic selector fallback for `click`/`fill`/`select`; `searchWeb` uses DuckDuckGo HTML fetch+parse; includes launch/operation timeouts, temporary failure cooldown, and Bun→Node fallback bridge for Playwright launches)
- Browser Node bridge: `packages/core/browser-node-bridge.mjs` (runs Playwright under `node` when Bun runtime cannot establish Chromium connection)
```

Replace with:
```
- Browser wrapper: `packages/core/browser.ts` (`browseUrl` calls Python microservice → Crawl4AI; `searchWeb` calls SearXNG REST API directly; `interactWithPage` calls Python microservice → browser-use LLM-driven automation)
```

Also update `interact_page` description in the Explorer tools section:

Find:
```
- Explorer tools: `packages/core/explorer-tools.ts` (`browse_url`, `search_web`, `interact_page` tool entries)
```

Replace with:
```
- Explorer tools: `packages/core/explorer-tools.ts` (`browse_url`, `search_web`, `interact_page` tool entries; `interact_page` uses natural language `task` parameter — browser-use decides actions autonomously; supports `{{credential:fieldname}}` placeholders in task string)
```

- [ ] **Step 4: Update README.md**

Find the "Explorer" or "explorer" section in README.md that describes the web browsing stack and update it to reflect SearXNG + Crawl4AI + browser-use. Key points to add:
- `docker-compose up searxng pi-browse-service -d` as the prereq command
- `OPENROUTER_API_KEY` needed for interact_page
- `interact_page` is now task-based (natural language)

- [ ] **Step 5: Update AGENTS.md**

Find the "Explorer" section and update tool descriptions to reflect the new interface. `interact_page` now takes `{ url, task }` instead of `{ url, actions[], followUpUrls? }`.

- [ ] **Step 6: Run typecheck one final time**

```bash
bun run typecheck
```

Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "docs: update explorer stack docs — SearXNG + Crawl4AI + browser-use"
```

```bash
# Final commit confirms the deletion is in history
git log --oneline -8
```

---

## Post-Implementation Verification

After all tasks complete, verify the full stack with real services:

```bash
# Start supporting services
docker-compose up searxng pi-browse-service -d

# Wait for health checks
sleep 30

# Run smoke test (requires OPENROUTER_API_KEY in env for interact_page)
bun run smoke:explorer
```

Expected: Explorer agent successfully uses `search_web` (SearXNG) and `browse_url` (Crawl4AI) in the smoke test. `interact_page` requires HITL approval and a live URL to test manually.
