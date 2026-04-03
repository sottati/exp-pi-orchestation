import logging
import os
import pathlib
import re
from typing import Any
from urllib.parse import urlparse

from browser_use import Agent
from browser_use.llm.openrouter.chat import ChatOpenRouter
from langchain_openai import ChatOpenAI


OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
# Format: "openrouter/google/gemini-3.1-flash-lite-preview"
# LangChain ChatOpenAI needs model without "openrouter/" prefix
BROWSE_LLM_MODEL = os.environ.get(
    "BROWSE_LLM_MODEL",
    "openrouter/google/gemini-3.1-flash-lite-preview",
)
logger = logging.getLogger("browse-service.interactor")

_AGENT_MAX_STEPS = 30
_AGENT_STEP_TIMEOUT_SEC = 180
_AGENT_LLM_TIMEOUT_SEC = 90
_AGENT_MAX_HISTORY_ITEMS = 40
_REPORT_MAX_ACTIONS = 10
_REPORT_MAX_URLS = 6
_REPORT_MAX_EXTRA_FINDINGS = 4
_REPORT_MAX_ERRORS = 3
_REPORT_ITEM_MAX_CHARS = 3500
_PLATFORM_SKILL_MAX_CHARS = 3500
_INTERACTION_MAX_RETRIES = int(os.environ.get("BROWSE_INTERACT_MAX_RETRIES", "1"))
_RETRY_CONTEXT_MAX_CHARS = 1200
_RETRYABLE_FAILURE_KEYWORDS = (
    "overlay",
    "modal",
    "pop-up",
    "popup",
    "interstitial",
    "full-screen",
    "advert",
    "cookie banner",
    "consent banner",
    "empty dom",
    "cdp requests failed",
    "frame with the given frameid is not found",
    "timed out",
)
_BLOCKER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "overlay_or_interstitial_ad": (
        "overlay",
        "interstitial",
        "full-screen",
        "fullscreen",
        "advert",
        "ad blocked",
    ),
    "notification_prompt": (
        "notification prompt",
        "onesignal",
        "subscribe",
        "allow notifications",
        "after",
        "después",
        "not now",
        "no thanks",
    ),
    "cookie_or_consent_banner": (
        "cookie banner",
        "consent banner",
        "cookie consent",
        "gdpr",
        "accept cookies",
    ),
    "dom_snapshot_failure": (
        "empty dom",
        "cdp requests failed",
        "frame with the given frameid is not found",
        "ax_tree",
        "dom build failed",
    ),
    "captcha_or_bot_challenge": (
        "captcha",
        "robot verification",
        "human verification",
    ),
    "authentication_wall": (
        "authentication failed",
        "login required",
        "sign in",
        "2fa",
        "two-factor",
    ),
}
_BLOCKER_LABELS: dict[str, str] = {
    "overlay_or_interstitial_ad": "overlay/interstitial ad",
    "notification_prompt": "notification prompt",
    "cookie_or_consent_banner": "cookie/consent banner",
    "dom_snapshot_failure": "DOM snapshot failure",
    "captcha_or_bot_challenge": "captcha/bot challenge",
    "authentication_wall": "authentication wall",
}


def _ensure_browser_use_provider(llm: ChatOpenAI) -> ChatOpenAI:
    # browser-use 0.1.x reads llm.provider directly during Agent init.
    # ChatOpenAI models don't expose this field, so we set it explicitly.
    if hasattr(llm, "provider"):
        return llm
    try:
        object.__setattr__(llm, "provider", "openrouter")
    except Exception:
        logger.debug("could not set llm.provider compatibility field", exc_info=True)
    return llm


def _build_llm(api_key: str | None = None) -> Any:
    resolved_key = api_key or OPENROUTER_API_KEY
    if not resolved_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not configured. interact_page requires a valid OpenRouter API key."
        )
    model_name = BROWSE_LLM_MODEL.removeprefix("openrouter/")
    try:
        return ChatOpenRouter(
            model=model_name,
            api_key=resolved_key,
            base_url="https://openrouter.ai/api/v1",
        )
    except Exception:
        logger.debug("ChatOpenRouter init failed, falling back to ChatOpenAI", exc_info=True)
        llm = ChatOpenAI(
            model=model_name,
            api_key=resolved_key,
            base_url="https://openrouter.ai/api/v1",
        )
        return _ensure_browser_use_provider(llm)


_EXTRACT_KEYWORDS = (
    "extract",
    "return",
    "report",
    "show",
    "get the content",
    "describe",
    "list",
    "table",
    "price",
    "data",
)

# Extend the browser-use default system prompt with task-execution guidance.
# Uses extend_system_message so the default tool/action instructions are preserved.
_BROWSER_AGENT_EXTENSION = """
## Interaction playbook (override conflicting defaults)

OUTPUT QUALITY
- Your final result must contain concrete findings from the website, not a narration of clicks.
- Prefer structured output with entities, values, dates, IDs, links, and statuses when available.
- If multiple items are found, rank or group them in a table or numbered list.
- Mark uncertain values explicitly as uncertain.

EXECUTION QUALITY
- Complete the task in the minimum number of meaningful steps.
- Once required data is visible, extract it immediately and avoid unnecessary clicks.
- After major navigation, verify the URL/title changed before continuing.
- If an action repeats without progress, switch strategy (search, go back, alternative element, keyboard).
- Handle cookie/pop-up banners only if they block progress.

SAFETY
- Do not submit purchases, payments, or checkout flows.
- Do not create accounts or sign-up flows unless explicitly requested.
- Do not delete, archive, or modify existing data unless explicitly instructed.
- Do not click sponsored content unless the user explicitly asks for ads.

WHEN BLOCKED
- CAPTCHA: report exactly "BLOCKED: CAPTCHA detected at <url>".
- Login failure or 2FA wall: report exactly "BLOCKED: authentication failed - <reason>".
- Hard paywall: report exactly "BLOCKED: paywall at <url>".
- Do not retry failed login more than once.

CREDENTIALS
- Credentials may appear as {{credential:fieldname}} placeholders and are pre-substituted before you receive the task.
- Never print or expose credential values in any output.
"""


# Skills root: project_root/skills/browser/<domain>/SKILL.md
# Searched relative to this file's location (services/browse-service/ -> ../../skills/browser/)
_SKILLS_ROOT = pathlib.Path(__file__).parent.parent.parent / "skills" / "browser"
_OFFICIAL_SKILLS_ROOT = _SKILLS_ROOT / "_official"
_OFFICIAL_INTERACTION_SKILLS = ("interaction",)
_OFFICIAL_SKILL_MAX_CHARS = int(os.environ.get("BROWSE_OFFICIAL_SKILL_MAX_CHARS", "2500"))
_OFFICIAL_SKILL_TOTAL_MAX_CHARS = int(os.environ.get("BROWSE_OFFICIAL_SKILL_TOTAL_MAX_CHARS", "5000"))


def _strip_yaml_frontmatter(raw: str) -> str:
    if raw.startswith("---"):
        sections = raw.split("---", 2)
        return sections[2].strip() if len(sections) >= 3 else raw.strip()
    return raw.strip()


def _sanitize_skill_body(body: str, max_chars: int) -> str:
    body = re.sub(r"```[\s\S]*?```", "", body)
    lines = [line for line in body.splitlines() if not re.match(r"^\s*\|[-\s|]+\|\s*$", line)]
    compact = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if len(compact) > max_chars:
        return compact[:max_chars].rstrip() + "\n...[truncated skill]"
    return compact


def _load_interaction_skills() -> str:
    loaded_parts: list[str] = []
    total_chars = 0

    for skill_name in _OFFICIAL_INTERACTION_SKILLS:
        skill_path = _OFFICIAL_SKILLS_ROOT / skill_name / "SKILL.md"
        if not skill_path.exists():
            continue
        try:
            raw = skill_path.read_text(encoding="utf-8")
        except Exception:
            logger.debug("official skill read failed file=%s", skill_path, exc_info=True)
            continue

        body = _sanitize_skill_body(_strip_yaml_frontmatter(raw), _OFFICIAL_SKILL_MAX_CHARS)
        if not body:
            continue

        remaining = _OFFICIAL_SKILL_TOTAL_MAX_CHARS - total_chars
        if remaining <= 0:
            break
        if len(body) > remaining:
            body = body[:remaining].rstrip() + "\n...[truncated official skills bundle]"

        loaded_parts.append(f"\n\n## Interaction skill ({skill_name})\n\n{body}")
        total_chars += len(body)

    if loaded_parts:
        logger.info("interaction skills loaded count=%s chars=%s", len(loaded_parts), total_chars)

    return "".join(loaded_parts)


def _load_platform_skill(url: str) -> str:
    """Return platform-specific skill content for the given URL, or empty string."""
    try:
        netloc = urlparse(url).netloc.lower().removeprefix("www.")
        # Try progressively shorter domain suffixes: app.linkedin.com -> linkedin.com -> linkedin
        parts = netloc.split(".")
        candidates = []
        for i in range(len(parts)):
            candidates.append(".".join(parts[i:]))
        candidates.append(parts[-2] if len(parts) >= 2 else parts[0])

        for candidate in candidates:
            skill_path = _SKILLS_ROOT / candidate / "SKILL.md"
            if skill_path.exists():
                raw = skill_path.read_text(encoding="utf-8")
                body = _sanitize_skill_body(_strip_yaml_frontmatter(raw), _PLATFORM_SKILL_MAX_CHARS)
                logger.info("platform skill loaded domain=%s file=%s", candidate, skill_path)
                return f"\n\n## Platform-specific guidance ({netloc})\n\n{body}"
    except Exception:
        logger.debug("platform skill lookup failed url=%s", url, exc_info=True)
    return ""


def _needs_extraction_hint(task: str) -> bool:
    lower = task.lower()
    for keyword in _EXTRACT_KEYWORDS:
        pattern = r"\b" + re.escape(keyword) + r"\b"
        if re.search(pattern, lower):
            return False
    return True


def _call_history_method(history: Any, name: str) -> Any:
    method = getattr(history, name, None)
    if not callable(method):
        return None
    try:
        return method()
    except Exception:
        logger.debug("history method failed name=%s", name, exc_info=True)
        return None


def _history_dict(history: Any, name: str) -> dict[str, Any]:
    raw = _call_history_method(history, name)
    if isinstance(raw, dict):
        return raw
    return {}


def _history_strings(history: Any, name: str) -> list[str]:
    raw = _call_history_method(history, name)
    if raw is None:
        return []

    if isinstance(raw, str):
        items: list[Any] = [raw]
    elif isinstance(raw, (list, tuple, set)):
        items = list(raw)
    else:
        items = [raw]

    values: list[str] = []
    for item in items:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        values.append(text)
    return values


def _dedupe_preserving_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = re.sub(r"\s+", " ", item).strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n...[truncated]"


def _classify_status(
    findings: list[str],
    errors: list[str],
    successful: Any,
    done: Any,
    judge_verdict: Any,
) -> str:
    joined = " ".join(findings).upper()
    if "BLOCKED:" in joined:
        return "BLOCKED"
    if judge_verdict is False:
        return "VALIDATION_FAILED"
    if successful is True:
        return "SUCCESS"
    if done is True and errors:
        return "DONE_WITH_WARNINGS"
    if done is True:
        return "DONE"
    if errors:
        return "PARTIAL_WITH_ERRORS"
    return "PARTIAL"


def _collect_attempt_data(history: Any, fallback_url: str) -> dict[str, Any]:
    final_result = _call_history_method(history, "final_result")
    raw_findings: list[str] = []
    if isinstance(final_result, str) and final_result.strip():
        raw_findings.append(final_result.strip())
    raw_findings.extend(_history_strings(history, "extracted_content"))

    findings = [_truncate_text(f, _REPORT_ITEM_MAX_CHARS) for f in _dedupe_preserving_order(raw_findings)]

    urls = _dedupe_preserving_order(_history_strings(history, "urls"))
    final_url = urls[-1] if urls else fallback_url

    actions = _dedupe_preserving_order(_history_strings(history, "action_names"))
    actions = actions[:_REPORT_MAX_ACTIONS]

    errors = [e for e in _dedupe_preserving_order(_history_strings(history, "errors")) if e.lower() != "none"]
    errors = [_truncate_text(e, 500) for e in errors[:_REPORT_MAX_ERRORS]]

    steps = _call_history_method(history, "number_of_steps")
    successful = _call_history_method(history, "is_successful")
    done = _call_history_method(history, "is_done")
    judgement = _history_dict(history, "judgement")
    judge_verdict = judgement.get("verdict") if isinstance(judgement.get("verdict"), bool) else None
    judge_failure_reason = str(judgement.get("failure_reason") or "").strip()
    judge_reasoning = str(judgement.get("reasoning") or "").strip()
    judge_impossible_task = (
        judgement.get("impossible_task") if isinstance(judgement.get("impossible_task"), bool) else None
    )
    blocker_text = " ".join(errors + [judge_failure_reason, judge_reasoning] + findings)
    blockers = _detect_blockers_from_text(blocker_text)
    status = _classify_status(findings, errors, successful, done, judge_verdict)

    return {
        "status": status,
        "final_url": final_url,
        "steps": steps if isinstance(steps, int) else None,
        "actions": actions,
        "urls": urls,
        "findings": findings,
        "errors": errors,
        "successful": successful,
        "done": done,
        "judge_verdict": judge_verdict,
        "judge_failure_reason": judge_failure_reason,
        "judge_reasoning": judge_reasoning,
        "judge_impossible_task": judge_impossible_task,
        "blockers": blockers,
    }


def _format_result_report_from_data(
    data: dict[str, Any],
    *,
    attempt_number: int,
    total_attempts: int,
) -> str:
    status = str(data["status"])
    final_url = str(data["final_url"])
    steps = data["steps"]
    actions = data["actions"]
    urls = data["urls"]
    findings = data["findings"]
    errors = data["errors"]
    blockers = data["blockers"]
    judge_verdict = data["judge_verdict"]
    judge_failure_reason = data["judge_failure_reason"]
    judge_reasoning = data["judge_reasoning"]

    report_title = "Interaction Report"
    if total_attempts > 1:
        report_title = f"Interaction Report (attempt {attempt_number}/{total_attempts})"

    lines = [
        report_title,
        f"Status: {status}",
        f"Final URL: {final_url}",
        f"Steps executed: {steps if isinstance(steps, int) else 'n/a'}",
        f"Actions observed: {', '.join(actions) if actions else 'n/a'}",
    ]

    if urls:
        lines.append("")
        lines.append(f"Visited URLs ({len(urls)}):")
        for index, visited_url in enumerate(urls[-_REPORT_MAX_URLS:], start=1):
            lines.append(f"{index}. {visited_url}")

    lines.append("")
    lines.append("Main findings:")
    if findings:
        lines.append(findings[0])
    else:
        lines.append("No extractable content returned by browser-use.")

    extra_findings = findings[1 : 1 + _REPORT_MAX_EXTRA_FINDINGS]
    if extra_findings:
        lines.append("")
        lines.append("Additional extracted findings:")
        for index, finding in enumerate(extra_findings, start=1):
            lines.append(f"{index}. {finding}")

    if errors:
        lines.append("")
        lines.append("Warnings/Errors:")
        for index, err in enumerate(errors, start=1):
            lines.append(f"{index}. {err}")

    lines.append("")
    lines.append(f"Observed blockers: {_format_blockers(blockers)}")

    lines.append("")
    if judge_verdict is True:
        lines.append("Judge validation: PASS")
    elif judge_verdict is False:
        lines.append("Judge validation: FAIL")
    else:
        lines.append("Judge validation: n/a")

    if judge_failure_reason:
        lines.append(f"Judge failure reason: {_truncate_text(judge_failure_reason, 600)}")
    if judge_reasoning and judge_verdict is False:
        lines.append(f"Judge reasoning: {_truncate_text(judge_reasoning, 800)}")

    return "\n".join(lines)


def _format_result_report(history: Any, fallback_url: str) -> tuple[str, str]:
    data = _collect_attempt_data(history, fallback_url)
    report = _format_result_report_from_data(data, attempt_number=1, total_attempts=1)
    return report, str(data["final_url"])


def _contains_any_keyword(text: str, keywords: tuple[str, ...]) -> bool:
    lower = text.lower()
    return any(keyword in lower for keyword in keywords)


def _detect_blockers_from_text(text: str) -> list[str]:
    lower = text.lower()
    blockers: list[str] = []
    for blocker_id, keywords in _BLOCKER_KEYWORDS.items():
        if any(keyword in lower for keyword in keywords):
            blockers.append(blocker_id)
    return blockers


def _format_blockers(blockers: list[str]) -> str:
    if not blockers:
        return "none"
    labels = [_BLOCKER_LABELS.get(blocker_id, blocker_id) for blocker_id in blockers]
    return ", ".join(labels)


def _blocker_retry_playbook(blockers: list[str]) -> str:
    lines: list[str] = []
    blocker_set = set(blockers)

    if {
        "overlay_or_interstitial_ad",
        "notification_prompt",
        "cookie_or_consent_banner",
    } & blocker_set:
        lines.append(
            "- First, clear blocking UI before extraction: overlays/modals/cookie banners/notification prompts."
        )
        lines.append(
            "- Prioritize close/dismiss actions using visible controls like: Cerrar, X, Close, No thanks, Not now, Después, Omitir."
        )
        lines.append("- If a click index fails, refresh page state and retry with updated element index.")

    if "dom_snapshot_failure" in blocker_set:
        lines.append("- If DOM/snapshot is unstable, wait 2-3s and reload once before continuing.")

    if "captcha_or_bot_challenge" in blocker_set:
        lines.append("- If captcha persists, stop and return BLOCKED with exact reason and URL.")

    if "authentication_wall" in blocker_set:
        lines.append("- If login wall persists without valid auth, return BLOCKED with exact reason and URL.")

    lines.append("- Before calling done, verify output against currently visible page text.")
    lines.append("- Do not guess missing items; if only partial content is visible, return PARTIAL with what is visible.")

    return "\n".join(lines)


def _should_retry_attempt(data: dict[str, Any], attempt_number: int, max_retries: int) -> tuple[bool, str]:
    retries_used = max(0, attempt_number - 1)
    retries_remaining = max_retries - retries_used

    if data["status"] == "BLOCKED":
        return False, "blocked"
    if data["judge_impossible_task"] is True:
        return False, "judge_impossible_task"

    judge_verdict = data["judge_verdict"]
    findings = data["findings"]
    errors = data["errors"]
    blockers = data["blockers"]
    judge_failure_reason = str(data["judge_failure_reason"] or "")
    judge_reasoning = str(data["judge_reasoning"] or "")
    combined_runtime_signals = " ".join(errors + [judge_failure_reason, judge_reasoning]).strip()

    should_retry = False
    retry_reason = "completed"

    if judge_verdict is False:
        should_retry = True
        if blockers:
            retry_reason = "judge_failed_blockers_detected"
        elif _contains_any_keyword(combined_runtime_signals, _RETRYABLE_FAILURE_KEYWORDS):
            retry_reason = "judge_failed_retryable_signal"
        else:
            retry_reason = "judge_failed"
    elif not findings:
        should_retry = True
        retry_reason = "missing_findings"
    elif data["status"] in {"PARTIAL", "PARTIAL_WITH_ERRORS", "DONE_WITH_WARNINGS"}:
        should_retry = True
        retry_reason = "partial_or_warning_status"
    elif _contains_any_keyword(combined_runtime_signals, _RETRYABLE_FAILURE_KEYWORDS):
        should_retry = True
        retry_reason = "retryable_runtime_signal"

    if not should_retry:
        return False, "completed"
    if retries_remaining <= 0:
        return False, "retry_limit_reached"
    return True, retry_reason


def _build_retry_task(base_task: str, data: dict[str, Any], retry_reason: str, next_attempt_number: int) -> str:
    blockers: list[str] = list(data.get("blockers", []))
    context_lines = [
        f"Retry attempt {next_attempt_number}.",
        f"Retry reason: {retry_reason}.",
        f"Previous status: {data['status']}.",
        f"Previous final URL: {data['final_url']}.",
        f"Observed blockers: {_format_blockers(blockers)}.",
    ]

    judge_failure_reason = str(data["judge_failure_reason"] or "").strip()
    if judge_failure_reason:
        context_lines.append(f"Judge failure reason: {judge_failure_reason}")

    for index, err in enumerate(data["errors"][:2], start=1):
        context_lines.append(f"Previous runtime warning {index}: {err}")

    context_text = _truncate_text("\n".join(context_lines), _RETRY_CONTEXT_MAX_CHARS)

    retry_instructions = _blocker_retry_playbook(blockers)
    return f"{base_task}\n\n[Retry context]\n{context_text}\n\n[Retry instructions]\n{retry_instructions}"


def _append_retry_summary(final_report: str, attempt_logs: list[str]) -> str:
    if not attempt_logs:
        return final_report

    lines = [final_report, "", "Retry Summary:"]
    for index, entry in enumerate(attempt_logs, start=1):
        lines.append(f"{index}. {entry}")
    return "\n".join(lines)


async def interact_page(url: str, task: str, api_key: str | None = None) -> dict:
    logger.info("interact_page start url=%s model=%s", url, BROWSE_LLM_MODEL)
    try:
        llm = _build_llm(api_key)
        full_task = f"Navigate to {url} and then: {task}"
        if _needs_extraction_hint(task):
            full_task += (
                " After completing all actions, extract and return "
                "the full visible text content of the final page."
            )

        interaction_skills = _load_interaction_skills()
        platform_skill = _load_platform_skill(url)

        max_retries = max(0, _INTERACTION_MAX_RETRIES)
        total_attempts = max_retries + 1
        attempt_logs: list[str] = []
        current_task = full_task
        result = ""
        final_url = url

        for attempt in range(1, total_attempts + 1):
            agent = Agent(
                task=current_task,
                llm=llm,
                extend_system_message=_BROWSER_AGENT_EXTENSION + interaction_skills + platform_skill,
                step_timeout=_AGENT_STEP_TIMEOUT_SEC,
                llm_timeout=_AGENT_LLM_TIMEOUT_SEC,
                max_history_items=_AGENT_MAX_HISTORY_ITEMS,
            )
            history = await agent.run(max_steps=_AGENT_MAX_STEPS)

            data = _collect_attempt_data(history, url)
            result = _format_result_report_from_data(
                data,
                attempt_number=attempt,
                total_attempts=total_attempts,
            )
            final_url = str(data["final_url"])

            should_retry, retry_reason = _should_retry_attempt(data, attempt, max_retries)
            attempt_logs.append(
                "Attempt "
                f"{attempt}: status={data['status']}, judge={data['judge_verdict']}, "
                f"blockers={_format_blockers(data['blockers'])}, decision={retry_reason}"
            )
            logger.info(
                "interact_page attempt=%s/%s status=%s judge_verdict=%s retry=%s reason=%s",
                attempt,
                total_attempts,
                data["status"],
                data["judge_verdict"],
                should_retry,
                retry_reason,
            )

            if not should_retry:
                break

            current_task = _build_retry_task(
                full_task,
                data,
                retry_reason=retry_reason,
                next_attempt_number=attempt + 1,
            )

        result = _append_retry_summary(result, attempt_logs)
        return {
            "result": result,
            "final_url": final_url,
        }
    except Exception as exc:
        logger.exception("interact_page failed url=%s model=%s", url, BROWSE_LLM_MODEL)
        raise RuntimeError(f"browser-use interaction failed: {type(exc).__name__}: {exc}") from exc
