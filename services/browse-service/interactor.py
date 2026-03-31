import os
import logging

from langchain_openai import ChatOpenAI
from browser_use import Agent


OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
# Format: "openrouter/google/gemini-3.1-flash-lite-preview"
# LangChain ChatOpenAI needs model without "openrouter/" prefix
BROWSE_LLM_MODEL = os.environ.get(
    "BROWSE_LLM_MODEL",
    "openrouter/google/gemini-3.1-flash-lite-preview",
)
logger = logging.getLogger("browse-service.interactor")


def _build_llm() -> ChatOpenAI:
    if not OPENROUTER_API_KEY:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not configured. interact_page requires a valid OpenRouter API key."
        )
    model_name = BROWSE_LLM_MODEL.removeprefix("openrouter/")
    return ChatOpenAI(
        model=model_name,
        api_key=OPENROUTER_API_KEY,
        base_url="https://openrouter.ai/api/v1",
    )


_EXTRACT_KEYWORDS = ("extract", "return", "report", "show", "get the content", "describe", "list")


def _needs_extraction_hint(task: str) -> bool:
    lower = task.lower()
    return not any(kw in lower for kw in _EXTRACT_KEYWORDS)


async def interact_page(url: str, task: str) -> dict:
    logger.info("interact_page start url=%s model=%s", url, BROWSE_LLM_MODEL)
    try:
        llm = _build_llm()
        full_task = f"Navigate to {url} and then: {task}"
        if _needs_extraction_hint(task):
            full_task += (
                " After completing all actions, extract and return "
                "the full visible text content of the final page."
            )
        agent = Agent(task=full_task, llm=llm)
        history = await agent.run(max_steps=20)

        # Collect result: prefer final_result(), fall back to extracted_content()
        final_result = history.final_result() or ""
        extracted: list = []
        if hasattr(history, "extracted_content"):
            extracted = history.extracted_content() or []

        parts = [p for p in [final_result] + [str(e) for e in extracted] if p and p.strip()]
        result = "\n\n".join(parts) if parts else "Task completed"

        urls = history.urls() if hasattr(history, "urls") else []
        final_url = urls[-1] if urls else url
        return {
            "result": result,
            "final_url": final_url,
        }
    except Exception as exc:
        logger.exception("interact_page failed url=%s model=%s", url, BROWSE_LLM_MODEL)
        raise RuntimeError(f"browser-use interaction failed: {type(exc).__name__}: {exc}") from exc
