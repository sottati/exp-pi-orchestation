# Web Exploring Stack Improvement — Design Spec

**Date:** 2026-03-28

## Goal

Replace the current web exploring stack (DuckDuckGo HTML scraping + Playwright DOM snapshots with noisy output) with a token-efficient, capable stack: SearXNG for search, Crawl4AI for content extraction, and browser-use for autonomous page interaction.

## Problem Statement

Current stack limitations:
- `search_web`: scrapes DuckDuckGo HTML — fragile, rate-limited, no JSON API
- `browse_url`: returns raw DOM snapshot (~8000 chars) — noisy, ~75% token waste
- `interact_page`: relies on explicit CSS selectors provided by the agent — brittle on dynamic/JS-heavy sites, requires the agent to reason about DOM structure

## Architecture

```
search_web    →  packages/core/browser.ts
                 → HTTP GET http://searxng:8080/search?q=...&format=json
                 → Docker: searxng/searxng

browse_url    →  packages/core/browser.ts
                 → HTTP POST http://pi-browse-service:8001/browse
                 → Docker: pi-browse-service (FastAPI + Crawl4AI)

interact_page →  packages/core/browser.ts
                 → HTTP POST http://pi-browse-service:8001/interact
                 → Docker: pi-browse-service (FastAPI + browser-use)
```

All three tools remain in `packages/core/browser.ts` and `packages/core/explorer-tools.ts`. The interface of the tools toward the agents changes only for `interact_page` (task-based instead of action-based). External services are configured via env vars.

## Components

### 1. SearXNG (Docker container)

Self-hosted meta-search engine. Called directly from TypeScript via HTTP GET.

**Config file:** `services/searxng/settings.yml`
- Enable JSON format output
- Engines: google, bing, duckduckgo
- Rate limiting off for localhost
- No UI required (API only)

**TS call:**
```typescript
const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
const res = await fetch(url);
const data = await res.json();
// data.results: [{ title, url, content }]
```

### 2. Python Microservice (`services/browse-service/`)

FastAPI service with two endpoints. Manages Playwright/Chromium internally via Crawl4AI and browser-use.

**File structure:**
```
services/browse-service/
  main.py            # FastAPI app, routes
  crawler.py         # Crawl4AI browse logic
  interactor.py      # browser-use interact logic
  requirements.txt
  Dockerfile
```

**`/browse` endpoint:**
- Input: `{ url: string, wait_for?: string }`
- Uses Crawl4AI `AsyncWebCrawler` with `PruningContentFilter`
- Returns: `{ markdown: string, title: string, url: string }`
- Output: clean markdown ~1500 chars vs ~8000 chars DOM noise

**`/interact` endpoint:**
- Input: `{ url: string, task: string }`
- Uses `browser-use` `Agent` with task-based navigation
- LLM: configured via `OPENROUTER_API_KEY` + `BROWSE_LLM_MODEL` env var (LangChain ChatOpenAI with OpenRouter base URL)
- Returns: `{ result: string, final_url: string }`

**`/health` endpoint:** `{ status: "ok" }`

### 3. `interact_page` Tool Interface Change

**Current interface** (explicit actions):
```typescript
{ url: string, actions: [{type, selector?, value?, timeout?}][], followUpUrls?: string[] }
```

**New interface** (task-based):
```typescript
{ url: string, task: string }
```

The agent no longer reasons about selectors — it describes the intent in natural language. browser-use decides the execution steps.

**Credential handling:** credential placeholders (`{{credential:username}}`) are resolved in the task string before sending to the Python service, same resolution logic as before but applied to the task string instead of individual action values.

### 4. Docker Compose (`docker-compose.yml` at project root)

```yaml
services:
  pi-backend:
    build: .
    ports: ["3000:3000"]
    environment:
      SEARXNG_URL: http://searxng:8080
      BROWSE_SERVICE_URL: http://pi-browse-service:8001
    depends_on: [searxng, pi-browse-service]

  pi-browse-service:
    build: ./services/browse-service
    ports: ["8001:8001"]
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      BROWSE_LLM_MODEL: ${BROWSE_LLM_MODEL:-openrouter/google/gemini-3.1-flash-lite-preview}

  searxng:
    image: searxng/searxng:latest
    ports: ["8080:8080"]
    volumes:
      - ./services/searxng:/etc/searxng
```

### 5. Environment Variables

| Variable | Default | Where |
|---|---|---|
| `SEARXNG_URL` | `http://localhost:8080` | Bun backend |
| `BROWSE_SERVICE_URL` | `http://localhost:8001` | Bun backend |
| `OPENROUTER_API_KEY` | — (required) | Python service |
| `BROWSE_LLM_MODEL` | `openrouter/google/gemini-3.1-flash-lite-preview` | Python service |

For local dev without Docker: run SearXNG and Python service manually or via `docker-compose up searxng pi-browse-service`, keep Bun backend on host.

## Error Handling

- **SearXNG unreachable**: `searchWeb()` throws, tool returns error — same behavior as current DuckDuckGo failure
- **Python service unreachable**: `browseUrl()` / `interactWithPage()` throw with descriptive message (service URL included for debugging)
- **Crawl4AI extraction empty**: return error with URL for agent to decide retry
- **browser-use timeout**: Python service has 120s timeout on `/interact`, returns error with partial progress if available
- **HTTP 4xx from Python service**: surface immediately, do not retry

## `browser.ts` Changes

Three functions are replaced:

| Function | Before | After |
|---|---|---|
| `searchWeb()` | DuckDuckGo HTML fetch + cheerio parse | `fetch(SEARXNG_URL/search?format=json)` |
| `browseUrl()` | Playwright DOM snapshot | `fetch(BROWSE_SERVICE_URL/browse, POST)` |
| `interactWithPage()` | Playwright explicit actions | `fetch(BROWSE_SERVICE_URL/interact, POST)` |

`safeLaunchAndRun()`, `browser-node-bridge.mjs`, and all Playwright infrastructure in `browser.ts` are removed. Playwright is now managed entirely inside the Python service.

## `explorer-tools.ts` Changes

- `browse_url`: no interface change (url + waitFor → markdown result)
- `search_web`: no interface change (query + maxResults → results list)
- `interact_page`: interface change — `actions[]` replaced by `task: string`; `followUpUrls` removed (browser-use handles multi-step navigation); credential placeholder resolution applied to task string

## Testing

- **Unit**: `searchWeb()`, `browseUrl()`, `interactWithPage()` tested with mock HTTP responses (no real services needed)
- **Integration**: `bun run smoke:explorer` hits real services — needs SearXNG + Python service running
- **Python service**: pytest with FastAPI `TestClient`, mock Crawl4AI and browser-use for unit tests
- **Smoke test update**: `smoke:explorer` must start services or assume they're running

## Files Created / Modified

| File | Action |
|---|---|
| `services/browse-service/main.py` | Create |
| `services/browse-service/crawler.py` | Create |
| `services/browse-service/interactor.py` | Create |
| `services/browse-service/requirements.txt` | Create |
| `services/browse-service/Dockerfile` | Create |
| `services/searxng/settings.yml` | Create |
| `docker-compose.yml` | Create |
| `packages/core/browser.ts` | Modify (replace 3 functions, remove Playwright infra) |
| `packages/core/browser-node-bridge.mjs` | Delete |
| `packages/core/explorer-tools.ts` | Modify (interact_page interface) |
| `CLAUDE.md` | Update (new prereqs, Docker instructions) |
| `README.md` | Update |
| `AGENTS.md` | Update |
