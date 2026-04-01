from langchain_openai import ChatOpenAI

from interactor import (
    _build_retry_task,
    _collect_attempt_data,
    _ensure_browser_use_provider,
    _format_result_report,
    _load_interaction_skills,
    _needs_extraction_hint,
    _should_retry_attempt,
)


class DummyHistory:
    def __init__(self, *, final_result, extracted, urls, actions, errors, steps, successful, done, judgement=None):
        self._final_result = final_result
        self._extracted = extracted
        self._urls = urls
        self._actions = actions
        self._errors = errors
        self._steps = steps
        self._successful = successful
        self._done = done
        self._judgement = judgement

    def final_result(self):
        return self._final_result

    def extracted_content(self):
        return self._extracted

    def urls(self):
        return self._urls

    def action_names(self):
        return self._actions

    def errors(self):
        return self._errors

    def number_of_steps(self):
        return self._steps

    def is_successful(self):
        return self._successful

    def is_done(self):
        return self._done

    def judgement(self):
        return self._judgement


def test_load_interaction_skill_bundle_contains_runtime_guidance():
    guidance = _load_interaction_skills()
    assert guidance
    assert "Interaction skill" in guidance
    assert "Extraction Quality" in guidance


def test_format_result_report_includes_summary_findings_and_context():
    history = DummyHistory(
        final_result="Top item: Product A ($120)",
        extracted=[
            "Top item: Product A ($120)",
            "Second item: Product B ($99)",
            "Published date: 2026-03-31",
        ],
        urls=["https://example.com", "https://example.com/results"],
        actions=["navigate", "click", "extract", "extract"],
        errors=[None, "minor timeout waiting for sidebar"],
        steps=6,
        successful=True,
        done=True,
    )

    report, final_url = _format_result_report(history, "https://fallback.local")

    assert final_url == "https://example.com/results"
    assert "Status: SUCCESS" in report
    assert "Final URL: https://example.com/results" in report
    assert "Actions observed: navigate, click, extract" in report
    assert "Main findings:" in report
    assert "Top item: Product A ($120)" in report
    assert "Additional extracted findings:" in report
    assert "Second item: Product B ($99)" in report
    assert "Warnings/Errors:" in report


def test_format_result_report_marks_blocked_status():
    history = DummyHistory(
        final_result="",
        extracted=["BLOCKED: CAPTCHA detected at https://example.com/login"],
        urls=["https://example.com/login"],
        actions=["navigate"],
        errors=[],
        steps=2,
        successful=False,
        done=True,
    )

    report, _ = _format_result_report(history, "https://fallback.local")
    assert "Status: BLOCKED" in report


def test_needs_extraction_hint_detects_explicit_extract_intent():
    assert _needs_extraction_hint("Extract top 5 headlines") is False
    assert _needs_extraction_hint("Login and open reports") is True


def test_ensure_browser_use_provider_injects_provider_for_chatopenai():
    llm = ChatOpenAI(
        model="google/gemini-3.1-flash-lite-preview",
        api_key="dummy",
        base_url="https://openrouter.ai/api/v1",
    )
    assert hasattr(llm, "provider") is False
    patched = _ensure_browser_use_provider(llm)
    assert getattr(patched, "provider", None) == "openrouter"


def test_retry_when_judge_fails_on_overlay_signal():
    history = DummyHistory(
        final_result="Titulares: ...",
        extracted=["Titulares: ..."],
        urls=["https://www.infobae.com/"],
        actions=["navigate", "done"],
        errors=["Empty DOM detected after navigation"],
        steps=2,
        successful=True,
        done=True,
        judgement={
            "verdict": False,
            "failure_reason": "A full-screen overlay ad blocked the page and content was not verified.",
            "reasoning": "The extracted content appears fabricated.",
            "impossible_task": False,
        },
    )
    data = _collect_attempt_data(history, "https://fallback.local")
    should_retry, reason = _should_retry_attempt(data, attempt_number=1, max_retries=1)
    assert data["status"] == "VALIDATION_FAILED"
    assert "overlay_or_interstitial_ad" in data["blockers"]
    assert should_retry is True
    assert reason in {"judge_failed", "judge_failed_retryable_signal", "judge_failed_blockers_detected"}


def test_no_retry_when_blocked_even_with_retry_budget():
    history = DummyHistory(
        final_result="",
        extracted=["BLOCKED: CAPTCHA detected at https://example.com/login"],
        urls=["https://example.com/login"],
        actions=["navigate"],
        errors=[],
        steps=2,
        successful=False,
        done=True,
        judgement={"verdict": False, "failure_reason": "Captcha detected", "impossible_task": False},
    )
    data = _collect_attempt_data(history, "https://fallback.local")
    should_retry, reason = _should_retry_attempt(data, attempt_number=1, max_retries=2)
    assert data["status"] == "BLOCKED"
    assert should_retry is False
    assert reason == "blocked"


def test_retry_task_includes_blocker_specific_instructions():
    data = {
        "status": "VALIDATION_FAILED",
        "final_url": "https://www.infobae.com/",
        "errors": ["Empty DOM detected after navigation"],
        "judge_failure_reason": "Full-screen overlay ad blocked view.",
        "blockers": ["overlay_or_interstitial_ad", "notification_prompt"],
    }
    retry_task = _build_retry_task(
        "Navigate to https://www.infobae.com/ and then: list headlines.",
        data,
        retry_reason="judge_failed_blockers_detected",
        next_attempt_number=2,
    )
    assert "Observed blockers: overlay/interstitial ad, notification prompt." in retry_task
    assert "clear blocking UI before extraction" in retry_task
    assert "Prioritize close/dismiss actions" in retry_task


def test_no_retry_when_success_and_judge_pass_even_if_blocker_mentions():
    history = DummyHistory(
        final_result="Headline 1, Headline 2",
        extracted=["Clicked button \"Después\"", "Headline 1", "Headline 2"],
        urls=["https://www.infobae.com/"],
        actions=["navigate", "click", "done"],
        errors=[],
        steps=3,
        successful=True,
        done=True,
        judgement={"verdict": True, "failure_reason": "", "reasoning": "", "impossible_task": False},
    )
    data = _collect_attempt_data(history, "https://fallback.local")
    should_retry, reason = _should_retry_attempt(data, attempt_number=1, max_retries=1)
    assert should_retry is False
    assert reason == "completed"
