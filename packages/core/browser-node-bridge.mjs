import { chromium } from "playwright";

function truncateContent(text, limit) {
  if (typeof text !== "string") return "";
  return text.length <= limit ? text : text.slice(0, limit);
}

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

async function runBrowse(task) {
  const browser = await chromium.launch({
    headless: true,
    timeout: task.launchTimeout ?? 30000,
  });
  try {
    const page = await browser.newPage();
    await page.goto(task.url, {
      waitUntil: "domcontentloaded",
      timeout: task.navTimeout ?? 30000,
    });

    if (task.waitFor) {
      await page.waitForSelector(task.waitFor, { timeout: 10000 }).catch(() => {});
    }

    const title = await page.title();
    const content = await page.evaluate(() => {
      const selectors = [
        "nav",
        "header",
        "footer",
        "[role=navigation]",
        "[role=banner]",
        ".ad",
        ".ads",
        "#cookie-banner",
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
      return document.body?.innerText ?? "";
    });

    return {
      title,
      url: page.url(),
      content: truncateContent(content, task.maxContentLength ?? 8000),
    };
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
    const page = await browser.newPage();
    await page.goto(task.url, {
      waitUntil: "domcontentloaded",
      timeout: task.navTimeout ?? 30000,
    });

    for (const action of task.actions ?? []) {
      switch (action?.type) {
        case "click":
          await page.click(action.selector, { timeout: 10000 });
          break;
        case "fill":
          await page.fill(action.selector, action.value, { timeout: 10000 });
          break;
        case "select":
          await page.selectOption(action.selector, action.value, { timeout: 10000 });
          break;
        case "wait":
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10000 }).catch(() => {});
          } else {
            await page.waitForTimeout(action.timeout ?? 3000);
          }
          break;
      }
    }

    const parts = [];
    const mainContent = await page.evaluate(() => document.body?.innerText ?? "");
    parts.push(truncateContent(mainContent, 4000));

    if (Array.isArray(task.followUpUrls)) {
      for (const followUrlRaw of task.followUpUrls) {
        try {
          const followUrl = validateHttpUrl(followUrlRaw);
          await page.goto(followUrl, {
            waitUntil: "domcontentloaded",
            timeout: task.navTimeout ?? 30000,
          });
          const followContent = await page.evaluate(() => document.body?.innerText ?? "");
          parts.push(`\n--- ${followUrl} ---\n${truncateContent(followContent, 4000)}`);
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

