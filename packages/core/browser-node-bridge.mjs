import { chromium } from "playwright";

function truncateContent(text, limit) {
  if (typeof text !== "string") return "";
  return text.length <= limit ? text : text.slice(0, limit);
}

const CONTENT_WAIT_TIMEOUT = 12000;
const NETWORK_IDLE_TIMEOUT = 8000;
const MAX_FRAME_COUNT = 4;
const MAX_FIELD_COUNT = 12;
const MAX_TEXT_SNIPPET = 2400;
const MAX_HTML_SNIPPET = 1200;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function validateHttpUrl(input) {
  let parsed;
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

async function waitForPageHydration(page, waitFor) {
  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: CONTENT_WAIT_TIMEOUT }).catch(() => {});
  }
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        const textLength = (body.innerText ?? "").trim().length;
        const interactiveCount = document.querySelectorAll("form,input,textarea,select,button").length;
        const iframeCount = document.querySelectorAll("iframe").length;
        return (
          document.readyState === "complete" ||
          textLength > 120 ||
          interactiveCount > 0 ||
          iframeCount > 0
        );
      },
      { timeout: CONTENT_WAIT_TIMEOUT },
    )
    .catch(() => {});
}

function summarizeField(field) {
  const parts = [
    field.tag,
    field.type ? `type=${field.type}` : "",
    field.id ? `id=${field.id}` : "",
    field.name ? `name=${field.name}` : "",
    field.placeholder ? `placeholder=${field.placeholder}` : "",
    field.label ? `label=${field.label}` : "",
    field.text ? `text=${field.text}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function formatFrameSummary(summary) {
  const lines = [];
  const frameHeader = summary.isMainFrame
    ? `Frame: main (${summary.frameUrl || "about:blank"})`
    : `Frame: child (${summary.frameUrl || "about:blank"}) name=${summary.frameName || "-"}`;
  lines.push(frameHeader);
  lines.push(
    [
      `readyState=${summary.readyState || "unknown"}`,
      `forms=${summary.forms.length}`,
      `inputs=${summary.inputs.length}`,
      `buttons=${summary.buttons.length}`,
      `iframes=${summary.iframeCount}`,
      `scripts=${summary.scriptCount}`,
      `links=${summary.linkCount}`,
      `appRoot=${summary.appRootDetected ? "yes" : "no"}`,
    ].join(", "),
  );
  if (summary.text) {
    lines.push(`Text: ${truncateContent(summary.text, MAX_TEXT_SNIPPET)}`);
  } else if (summary.htmlSnippet) {
    lines.push(`HTML snippet: ${summary.htmlSnippet}`);
  } else {
    lines.push("Text: (empty)");
  }
  if (summary.forms.length > 0) {
    lines.push(`Forms: ${summary.forms.map(summarizeField).join(" | ")}`);
  }
  if (summary.inputs.length > 0) {
    lines.push(`Inputs: ${summary.inputs.map(summarizeField).join(" | ")}`);
  }
  if (summary.buttons.length > 0) {
    lines.push(`Buttons: ${summary.buttons.map(summarizeField).join(" | ")}`);
  }
  return lines.join("\n");
}

async function captureFrameSummary(frame, isMainFrame) {
  const frameUrl = frame.url();
  const frameName = frame.name();
  try {
    const data = await frame.evaluate(({ maxFieldCount, maxHtmlLength }) => {
      const clean = (value, max = 120) => {
        if (typeof value !== "string") return "";
        return value.replace(/\s+/g, " ").trim().slice(0, max);
      };

      const readLabel = (el) => {
        const id = el.id;
        if (!id) return "";
        const safeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
        const label = document.querySelector(`label[for="${safeId}"]`);
        return clean(label?.textContent ?? "");
      };

      const toFieldSummary = (el) => {
        const tag = el.tagName.toLowerCase();
        const type = "type" in el && typeof el.type === "string" ? clean(el.type, 40) : "";
        const id = "id" in el ? clean(el.id, 80) : "";
        const name = "name" in el ? clean(el.name, 80) : "";
        const placeholder = "placeholder" in el ? clean(el.placeholder, 120) : "";
        const ariaLabel = clean(el.getAttribute?.("aria-label") ?? "", 120);
        const label = clean(readLabel(el), 120) || ariaLabel;
        const text = clean(el.innerText ?? el.textContent ?? "", 120);
        return { tag, type, id, name, placeholder, label, text };
      };

      const forms = Array.from(document.querySelectorAll("form"))
        .slice(0, maxFieldCount)
        .map((form) => ({
          tag: "form",
          id: clean(form.id, 80),
          name: clean(form.name, 80),
          type: clean(form.method || "get", 40),
          placeholder: clean(form.getAttribute("action") ?? "", 120),
          label: clean(form.getAttribute("aria-label") ?? "", 120),
          text: "",
        }));

      const inputs = Array.from(document.querySelectorAll("input,textarea,select"))
        .slice(0, maxFieldCount)
        .map((input) => toFieldSummary(input));

      const buttons = Array.from(
        document.querySelectorAll("button,input[type=button],input[type=submit],input[type=reset]"),
      )
        .slice(0, maxFieldCount)
        .map((button) => toFieldSummary(button));

      return {
        readyState: clean(document.readyState, 40),
        appRootDetected: Boolean(
          document.querySelector("#root, #app, [data-reactroot], [data-v-app], [ng-app]"),
        ),
        iframeCount: document.querySelectorAll("iframe").length,
        scriptCount: document.querySelectorAll("script").length,
        linkCount: document.querySelectorAll("a[href]").length,
        text: clean(document.body?.innerText ?? "", 100000),
        htmlSnippet: clean(document.body?.innerHTML ?? "", maxHtmlLength),
        forms,
        inputs,
        buttons,
      };
    }, { maxFieldCount: MAX_FIELD_COUNT, maxHtmlLength: MAX_HTML_SNIPPET });

    return {
      frameUrl,
      frameName,
      isMainFrame,
      ...data,
    };
  } catch {
    return undefined;
  }
}

async function captureDomSnapshot(page) {
  const mainFrame = page.mainFrame();
  const frameSummaries = [];

  const mainSummary = await captureFrameSummary(mainFrame, true);
  if (mainSummary) frameSummaries.push(mainSummary);

  for (const frame of page.frames()) {
    if (frame === mainFrame) continue;
    if (frameSummaries.length >= MAX_FRAME_COUNT) break;
    const summary = await captureFrameSummary(frame, false);
    if (!summary) continue;
    const hasSignal =
      summary.text.length > 0 ||
      summary.forms.length > 0 ||
      summary.inputs.length > 0 ||
      summary.buttons.length > 0;
    if (!hasSignal) continue;
    frameSummaries.push(summary);
  }

  if (frameSummaries.length === 0) return "(empty DOM snapshot)";
  return frameSummaries.map((summary) => formatFrameSummary(summary)).join("\n\n---\n\n");
}

function splitSelectorCandidates(selector) {
  return String(selector ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractQuotedText(selector) {
  const match = String(selector ?? "").match(/["']([^"']{2,})["']/);
  return match?.[1]?.trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function hasAnyMatch(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function resolveActionLocator(page, selector, actionType) {
  const direct = page.locator(selector).first();
  if (await hasAnyMatch(direct)) return direct;

  for (const candidate of splitSelectorCandidates(selector)) {
    const locator = page.locator(candidate).first();
    if (await hasAnyMatch(locator)) return locator;
  }

  const lowered = String(selector ?? "").toLowerCase();
  if (actionType === "fill") {
    if (lowered.includes("pass")) {
      const password = page.locator("input[type='password']").first();
      if (await hasAnyMatch(password)) return password;
    }
    if (lowered.includes("user") || lowered.includes("email") || lowered.includes("login")) {
      const userField = page.locator("input[type='text'],input[type='email'],input:not([type]),textarea").first();
      if (await hasAnyMatch(userField)) return userField;
    }
    const genericField = page.locator("input,textarea").first();
    if (await hasAnyMatch(genericField)) return genericField;
  }

  if (actionType === "select") {
    const selectField = page.locator("select").first();
    if (await hasAnyMatch(selectField)) return selectField;
  }

  if (actionType === "click") {
    const quoted = extractQuotedText(selector);
    if (quoted) {
      const byRole = page.getByRole("button", { name: new RegExp(escapeRegex(quoted), "i") }).first();
      if (await hasAnyMatch(byRole)) return byRole;
    }
    const submit = page.locator("button[type='submit'],input[type='submit']").first();
    if (await hasAnyMatch(submit)) return submit;
    const generic = page.locator("button,[role='button'],a[role='button']").first();
    if (await hasAnyMatch(generic)) return generic;
  }

  return direct;
}

async function performClick(page, selector, timeoutMs) {
  const locator = await resolveActionLocator(page, selector, "click");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
    return;
  } catch (firstError) {
    try {
      await locator.click({ timeout: Math.min(2500, timeoutMs), force: true });
      return;
    } catch {
      const handle = await locator.elementHandle({ timeout: Math.min(2500, timeoutMs) }).catch(() => null);
      if (handle) {
        try {
          await handle.evaluate((el) => el.click());
          await handle.dispose();
          return;
        } catch {
          await handle.dispose().catch(() => {});
        }
      }
      throw firstError;
    }
  }
}

async function performFill(page, selector, value, timeoutMs) {
  const locator = await resolveActionLocator(page, selector, "fill");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.fill(value, { timeout: timeoutMs });
    return;
  } catch (firstError) {
    try {
      await locator.click({ timeout: Math.min(2500, timeoutMs), force: true });
      await locator.press("Control+A").catch(() => {});
      await locator.type(value, { timeout: timeoutMs, delay: 15 });
      return;
    } catch {
      throw firstError;
    }
  }
}

async function performSelect(page, selector, value, timeoutMs) {
  const locator = await resolveActionLocator(page, selector, "select");
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.selectOption(value, { timeout: timeoutMs });
}

async function runBrowse(task) {
  const browser = await chromium.launch({
    headless: true,
    timeout: task.launchTimeout ?? 30000,
  });
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(task.url, {
        waitUntil: "domcontentloaded",
        timeout: task.navTimeout ?? 30000,
      });
      await waitForPageHydration(page, task.waitFor);

      return {
        title: await page.title(),
        url: page.url(),
        content: truncateContent(await captureDomSnapshot(page), task.maxContentLength ?? 8000),
      };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runInteract(task) {
  const browser = await chromium.launch({
    headless: true,
    timeout: task.launchTimeout ?? 30000,
  });
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(task.url, {
        waitUntil: "domcontentloaded",
        timeout: task.navTimeout ?? 30000,
      });
      await waitForPageHydration(page);

      for (const action of task.actions ?? []) {
        try {
          switch (action?.type) {
            case "click":
              await performClick(page, action.selector, action.timeout ?? 10000);
              break;
            case "fill":
              await performFill(page, action.selector, action.value, action.timeout ?? 10000);
              break;
            case "select":
              await performSelect(page, action.selector, action.value, action.timeout ?? 10000);
              break;
            case "wait":
              if (action.selector) {
                await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10000 }).catch(() => {});
              } else {
                await page.waitForTimeout(action.timeout ?? 3000);
              }
              break;
          }
        } catch (actionError) {
          const selector = action && typeof action === "object" ? action.selector ?? "" : "";
          throw new Error(
            `Action ${action?.type ?? "unknown"} failed for selector "${selector}": ${actionError instanceof Error ? actionError.message : String(actionError)}`,
          );
        }
      }

      await waitForPageHydration(page);
      const parts = [];
      parts.push(truncateContent(await captureDomSnapshot(page), 4000));

      if (Array.isArray(task.followUpUrls)) {
        for (const followUrlRaw of task.followUpUrls) {
          try {
            const followUrl = validateHttpUrl(followUrlRaw);
            await page.goto(followUrl, {
              waitUntil: "domcontentloaded",
              timeout: task.navTimeout ?? 30000,
            });
            await waitForPageHydration(page);
            parts.push(`\n--- ${followUrl} ---\n${truncateContent(await captureDomSnapshot(page), 4000)}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            parts.push(`\n--- ${String(followUrlRaw)} ---\nError: ${message}`);
          }
        }
      }

      return {
        title: await page.title(),
        url: page.url(),
        content: truncateContent(parts.join("\n"), task.maxContentLength ?? 8000),
      };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  const task = JSON.parse(raw || "{}");

  if (!task || (task.kind !== "browse" && task.kind !== "interact")) {
    throw new Error("Invalid browser task");
  }

  task.url = validateHttpUrl(task.url);

  if (task.kind === "browse") {
    return await runBrowse(task);
  }
  return await runInteract(task);
}

try {
  const result = await main();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
}

