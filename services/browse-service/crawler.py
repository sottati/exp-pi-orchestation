import asyncio
import socket
from urllib.parse import urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator


async def _diagnose_connection(url: str) -> str:
    """Attempt a raw TCP connection to surface the real OS-level error."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: socket.create_connection((host, port), timeout=5).close(),
        )
        return ""  # TCP succeeded — error must be at a higher layer
    except socket.gaierror as e:
        return f"DNS lookup failed for '{host}': {e}"
    except ConnectionRefusedError as e:
        return f"Connection refused by '{host}:{port}': {e}"
    except TimeoutError:
        return f"TCP connection timed out to '{host}:{port}' (5s)"
    except OSError as e:
        return f"Network error reaching '{host}:{port}': {e}"
    except Exception as e:
        return f"{type(e).__name__} connecting to '{host}:{port}': {e}"


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
        diagnosis = await _diagnose_connection(url)
        raise RuntimeError(diagnosis or result.error_message or f"Crawl4AI failed for {url}")
    markdown = ""
    if result.markdown:
        markdown = result.markdown.fit_markdown or result.markdown.raw_markdown or ""
    return {
        "markdown": markdown,
        "title": (result.metadata or {}).get("title", ""),
        "url": result.url or url,
    }
