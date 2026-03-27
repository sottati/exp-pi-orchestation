import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { errorMessage } from "./errors";
import { safeLaunchAndRun } from "./browser";

export interface MarketingToolOptions {
  credentialStore?: CredentialStore;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function getSheetId(): string {
  const id = process.env.MARKETING_SHEET_ID;
  if (!id) {
    throw new Error(
      "MARKETING_SHEET_ID not configured — set env var or store in CredentialStore domain 'marketing'",
    );
  }
  return id;
}

export function createMarketingToolEntries(opts?: MarketingToolOptions): ToolEntry[] {
  const seoAudit: ToolEntry = {
    name: "seo_audit",
    source: "local",
    description:
      "Run an on-page SEO audit on a URL. Extracts title, meta tags, heading hierarchy, image alt texts, links, structured data, and page timing.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to audit" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const url = params.url as string;

      try {
        return await safeLaunchAndRun(async (page) => {
          const startTime = Date.now();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const loadTimeMs = Date.now() - startTime;

          interface SeoData {
            title: string | null;
            metaDescription: string | null;
            metaKeywords: string | null;
            ogTitle: string | null;
            ogDescription: string | null;
            ogImage: string | null;
            canonical: string | null;
            headings: { h1: string[]; h2: string[]; h3: string[] };
            imageAlts: string[];
            missingAltCount: number;
            totalImages: number;
            internalLinks: number;
            externalLinks: number;
            structuredData: unknown[];
          }

          const data: SeoData = await page.evaluate(() => {
            const getMeta = (name: string): string | null => {
              const el =
                document.querySelector(`meta[name="${name}"]`) ||
                document.querySelector(`meta[property="${name}"]`);
              return el?.getAttribute("content") ?? null;
            };

            const title = document.title || null;
            const metaDescription = getMeta("description");
            const metaKeywords = getMeta("keywords");
            const ogTitle = getMeta("og:title");
            const ogDescription = getMeta("og:description");
            const ogImage = getMeta("og:image");

            const canonicalEl = document.querySelector('link[rel="canonical"]');
            const canonical = canonicalEl?.getAttribute("href") ?? null;

            // Headings
            const headings: { h1: string[]; h2: string[]; h3: string[] } = { h1: [], h2: [], h3: [] };
            for (const level of ["h1", "h2", "h3"] as const) {
              document.querySelectorAll(level).forEach((el) => {
                headings[level]!.push((el as HTMLElement).innerText.trim());
              });
            }

            // Images
            const images = document.querySelectorAll("img");
            const totalImages = images.length;
            const alts: string[] = [];
            let missingAltCount = 0;
            images.forEach((img, i) => {
              const alt = img.getAttribute("alt");
              if (alt === null || alt.trim() === "") {
                missingAltCount++;
              } else if (i < 20) {
                alts.push(alt.trim());
              }
            });

            // Links
            const links = document.querySelectorAll("a[href]");
            let internalLinks = 0;
            let externalLinks = 0;
            links.forEach((a) => {
              const href = a.getAttribute("href") ?? "";
              if (
                href.startsWith("/") ||
                href.startsWith("#") ||
                href.startsWith(window.location.origin)
              ) {
                internalLinks++;
              } else if (href.startsWith("http")) {
                externalLinks++;
              }
            });

            // JSON-LD structured data
            const jsonLdScripts = document.querySelectorAll(
              'script[type="application/ld+json"]',
            );
            const structuredData: unknown[] = [];
            jsonLdScripts.forEach((script) => {
              try {
                structuredData.push(JSON.parse(script.textContent ?? ""));
              } catch {
                // skip malformed JSON-LD
              }
            });

            return {
              title,
              metaDescription,
              metaKeywords,
              ogTitle,
              ogDescription,
              ogImage,
              canonical,
              headings,
              imageAlts: alts,
              missingAltCount,
              totalImages,
              internalLinks,
              externalLinks,
              structuredData,
            };
          });

          // Identify issues
          const issues: string[] = [];
          if (!data.title) issues.push("Missing <title> tag");
          if (!data.metaDescription) issues.push("Missing meta description");
          if (data.headings.h1.length === 0) issues.push("Missing <h1> heading");
          if (data.headings.h1.length > 1)
            issues.push(`Multiple <h1> headings (${data.headings.h1.length})`);
          if (data.missingAltCount > 0)
            issues.push(
              `${data.missingAltCount} image(s) missing alt text`,
            );
          if (!data.canonical) issues.push("Missing canonical link");
          if (!data.ogTitle || !data.ogDescription)
            issues.push("Missing Open Graph tags (og:title / og:description)");

          // Format summary
          const lines: string[] = [];
          lines.push(`# SEO Audit: ${url}`);
          lines.push(`Load time: ${loadTimeMs}ms`);
          lines.push("");
          lines.push(`## Title`);
          lines.push(data.title ?? "(missing)");
          lines.push("");
          lines.push(`## Meta`);
          lines.push(`- Description: ${data.metaDescription ?? "(missing)"}`);
          lines.push(`- Keywords: ${data.metaKeywords ?? "(none)"}`);
          lines.push(`- Canonical: ${data.canonical ?? "(missing)"}`);
          lines.push("");
          lines.push(`## Open Graph`);
          lines.push(`- og:title: ${data.ogTitle ?? "(missing)"}`);
          lines.push(`- og:description: ${data.ogDescription ?? "(missing)"}`);
          lines.push(`- og:image: ${data.ogImage ?? "(missing)"}`);
          lines.push("");
          lines.push(`## Headings`);
          lines.push(`- H1 (${data.headings.h1.length}): ${data.headings.h1.join(", ") || "(none)"}`);
          lines.push(`- H2 (${data.headings.h2.length}): ${data.headings.h2.join(", ") || "(none)"}`);
          lines.push(`- H3 (${data.headings.h3.length}): ${data.headings.h3.join(", ") || "(none)"}`);
          lines.push("");
          lines.push(`## Images`);
          lines.push(`- Total: ${data.totalImages}`);
          lines.push(`- Missing alt: ${data.missingAltCount}`);
          if (data.imageAlts.length > 0) {
            lines.push(`- Sample alts: ${data.imageAlts.slice(0, 5).join("; ")}`);
          }
          lines.push("");
          lines.push(`## Links`);
          lines.push(`- Internal: ${data.internalLinks}`);
          lines.push(`- External: ${data.externalLinks}`);
          lines.push("");
          if (data.structuredData.length > 0) {
            lines.push(`## Structured Data (JSON-LD)`);
            lines.push(`Found ${data.structuredData.length} block(s)`);
            lines.push("");
          }
          if (issues.length > 0) {
            lines.push(`## Issues Found (${issues.length})`);
            for (const issue of issues) {
              lines.push(`- ${issue}`);
            }
          } else {
            lines.push(`## No major issues found`);
          }

          return textResult(lines.join("\n"), {
            url,
            loadTimeMs,
            issues,
            ...data,
          });
        });
      } catch (err) {
        return textResult(
          `Error auditing ${url}: ${errorMessage(err)}\n\nHint: ensure Playwright is installed (bunx playwright install chromium) and node is in PATH.`,
        );
      }
    },
  };

  return [seoAudit];
}
