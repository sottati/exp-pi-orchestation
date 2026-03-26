import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import { errorMessage } from "./errors";
import { safeLaunchAndRun, truncateContent } from "./browser";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const SCREENSHOTS_DIR = ".runtime-data/screenshots";
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

function ensureScreenshotDir(): string {
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  return SCREENSHOTS_DIR;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createFrontendToolEntries(): ToolEntry[] {
  const previewPage: ToolEntry = {
    name: "preview_page",
    source: "local",
    description: "Navigate to a URL, extract readable content, and save a screenshot. Returns text content (for LLM) and screenshot path (for human review).",
    parameters: Type.Object({
      url: Type.String({ description: "URL to preview (typically localhost dev server)" }),
      viewport: Type.Optional(Type.Object({
        width: Type.Number({ description: "Viewport width (default: 1280)" }),
        height: Type.Number({ description: "Viewport height (default: 720)" }),
      })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const viewport = (params.viewport as { width: number; height: number } | undefined) ?? DEFAULT_VIEWPORT;

      try {
        return await safeLaunchAndRun(async (page) => {
          await page.setViewportSize(viewport);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

          const title = await page.title();
          const content = await page.evaluate(() => {
            const selectors = ["nav", "header", "footer", "[role=navigation]", "[role=banner]", ".ad", ".ads"];
            for (const sel of selectors) {
              document.querySelectorAll(sel).forEach(el => el.remove());
            }
            return document.body?.innerText ?? "";
          });

          const dir = ensureScreenshotDir();
          const screenshotPath = join(dir, `preview-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });

          const resultData = {
            title,
            url: page.url(),
            viewport,
            screenshotPath,
          };
          return textResult(
            `# ${title}\nURL: ${page.url()}\nViewport: ${viewport.width}x${viewport.height}\nScreenshot: ${screenshotPath}\n\n${truncateContent(content)}`,
            resultData,
          );
        });
      } catch (err) {
        return textResult(`Error previewing ${url}: ${errorMessage(err)}`);
      }
    },
  };

  const checkResponsive: ToolEntry = {
    name: "check_responsive",
    source: "local",
    description: "Load a page at multiple viewports and compare content/layout metrics. Screenshots saved for human review; LLM receives text + metrics.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to check" }),
      viewports: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String(),
          width: Type.Number(),
          height: Type.Number(),
        }),
        { description: "Viewports to test. Defaults: mobile (375x667), tablet (768x1024), desktop (1440x900)." },
      )),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const viewports = (params.viewports as Array<{ name: string; width: number; height: number }> | undefined) ?? DEFAULT_VIEWPORTS;

      try {
        return await safeLaunchAndRun(async (page) => {
          const results: Array<{
            name: string;
            viewport: { width: number; height: number };
            content: string;
            metrics: { scrollHeight: number; elementCount: number };
            screenshotPath: string;
          }> = [];

          for (const vp of viewports) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

            const { content, scrollHeight, elementCount } = await page.evaluate(() => {
              return {
                content: document.body?.innerText ?? "",
                scrollHeight: document.documentElement.scrollHeight,
                elementCount: document.querySelectorAll("*").length,
              };
            });

            const dir = ensureScreenshotDir();
            const screenshotPath = join(dir, `responsive-${vp.name}-${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });

            results.push({
              name: vp.name,
              viewport: { width: vp.width, height: vp.height },
              content: truncateContent(content, 2000),
              metrics: { scrollHeight, elementCount },
              screenshotPath,
            });
          }

          const summary = results.map(r =>
            `## ${r.name} (${r.viewport.width}x${r.viewport.height})\nScroll height: ${r.metrics.scrollHeight}px | Elements: ${r.metrics.elementCount}\nScreenshot: ${r.screenshotPath}\n\n${r.content}`,
          ).join("\n\n---\n\n");

          return textResult(summary, { results: results.map(r => ({ ...r, content: undefined })) });
        });
      } catch (err) {
        return textResult(`Error checking responsive for ${url}: ${errorMessage(err)}`);
      }
    },
  };

  const validateAccessibility: ToolEntry = {
    name: "validate_accessibility",
    source: "local",
    description: "Run axe-core accessibility audit on a page. Returns violations grouped by severity.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to validate" }),
      standard: Type.Optional(Type.Union([
        Type.Literal("wcag2a"),
        Type.Literal("wcag2aa"),
      ], { description: "Accessibility standard (default: wcag2aa)" })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;
      const standard = (params.standard as "wcag2a" | "wcag2aa" | undefined) ?? "wcag2aa";

      try {
        const axeSource = await Bun.file(
          join(import.meta.dir, "../../node_modules/axe-core/axe.min.js"),
        ).text();

        return await safeLaunchAndRun(async (page) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.evaluate(axeSource);

          const axeResult = await page.evaluate((std: string) => {
            const tags = std === "wcag2a"
              ? ["wcag2a"]
              : ["wcag2a", "wcag2aa"];
            // @ts-ignore - axe is injected
            return (window as any).axe.run(document, { runOnly: { type: "tag", values: tags } });
          }, standard);

          const violations = (axeResult as any).violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            nodes: v.nodes.length,
          }));
          const passes = (axeResult as any).passes.length;
          const total = violations.length + passes;

          const summary = violations.length === 0
            ? `Accessibility check passed (${standard}): ${passes} rules passed, 0 violations.`
            : `Accessibility violations (${standard}): ${violations.length} issues found.\n\n` +
              violations.map((v: any) => `- [${v.impact}] ${v.id}: ${v.description} (${v.nodes} elements)`).join("\n");

          return textResult(summary, { violations, passes, total, standard });
        });
      } catch (err) {
        return textResult(`Error validating accessibility for ${url}: ${errorMessage(err)}`);
      }
    },
  };

  return [previewPage, checkResponsive, validateAccessibility];
}
