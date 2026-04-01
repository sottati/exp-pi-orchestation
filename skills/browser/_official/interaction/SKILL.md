---
name: interaction
description: Runtime interaction skill for the internal browser-use sub-agent. Focuses on robust navigation, reliable extraction, and clear reporting for downstream agents.
---

# Browser Interaction Skill

## Goal
Complete the requested web task with minimum steps and produce high-value extracted information.

## Interaction Strategy
- Start from the target URL, identify the shortest path to the requested data, then execute.
- Prefer stable interactions: visible text buttons, labeled inputs, and deterministic selectors.
- If click fails, try keyboard fallback (`Tab`/`Enter`) or alternate element.
- Avoid loops. If two attempts do not progress, change strategy.
- Handle cookie/pop-up banners only when they block progress.

## Extraction Quality
- Return facts, not narration.
- Capture key entities and values: names, prices, dates, counts, IDs, statuses, and URLs.
- When there are multiple items, rank or group them (table or numbered list).
- Keep uncertain data marked as uncertain.
- If there is no relevant data, say so explicitly.

## Reliability Rules
- Validate major navigation by checking URL/title changes.
- If redirected unexpectedly, recover using search/go-back and continue.
- If blocked by CAPTCHA, paywall, or failed authentication, stop and return a clear BLOCKED reason.

## Safety
- Do not submit payments, purchases, or irreversible actions.
- Do not create accounts unless explicitly requested.
- Do not expose credentials in output.
