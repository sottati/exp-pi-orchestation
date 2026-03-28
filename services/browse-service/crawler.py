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
