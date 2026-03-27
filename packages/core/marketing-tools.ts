import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { errorMessage } from "./errors";
import { safeLaunchAndRun } from "./browser";
import { getGoogleAuth } from "./google-auth";
import { google } from "googleapis";

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

interface SheetCrudOpts {
  credentialStore?: CredentialStore;
  tab: string;
  headers: string[];
  action: string;
  keyField: string;
  keyValue?: string;
  data?: Record<string, string>;
}

async function sheetCrud(opts: SheetCrudOpts) {
  const { tab, headers, action, keyField, keyValue, data } = opts;

  try {
    const spreadsheetId = getSheetId();
    const auth = await getGoogleAuth({ credentialStore: opts.credentialStore });
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${tab}!A:${String.fromCharCode(64 + headers.length)}`;

    if (action === "list") {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const allValues = res.data.values ?? [];
      if (allValues.length <= 1) {
        return textResult(JSON.stringify({ tab, rows: [], rowCount: 0 }));
      }
      const hdr = allValues[0] as string[];
      const rows = allValues.slice(1).map((row) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < hdr.length; i++) obj[hdr[i]!] = row[i] ?? null;
        return obj;
      });
      return textResult(JSON.stringify({ tab, rowCount: rows.length, rows }, null, 2));
    }

    if (!keyValue) {
      return textResult(`Error: ${keyField} is required for ${action}`);
    }

    if (action === "add") {
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:1` });
      if (!existing.data.values?.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab}!A1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [headers] },
        });
      }

      const row = headers.map((h) => {
        if (h === keyField) return keyValue;
        if (h === "Updated") return new Date().toISOString().slice(0, 10);
        const dataKey = h.charAt(0).toLowerCase() + h.slice(1);
        return data?.[dataKey] ?? data?.[h] ?? "";
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return textResult(`Added "${keyValue}" to ${tab}`);
    }

    // For update/remove, find the row
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const allValues = res.data.values ?? [];
    if (allValues.length <= 1) {
      return textResult(`Error: No data in ${tab}`);
    }
    const hdr = allValues[0] as string[];
    const keyCol = hdr.indexOf(keyField);
    if (keyCol === -1) {
      return textResult(`Error: Column "${keyField}" not found in ${tab}`);
    }
    const rowIndex = allValues.findIndex((row, i) => i > 0 && row[keyCol] === keyValue);
    if (rowIndex === -1) {
      return textResult(`Error: "${keyValue}" not found in ${tab}`);
    }

    if (action === "remove") {
      const clearRange = `${tab}!A${rowIndex + 1}:${String.fromCharCode(64 + headers.length)}${rowIndex + 1}`;
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: clearRange });
      return textResult(`Removed "${keyValue}" from ${tab}`);
    }

    if (action === "update") {
      const existingRow = allValues[rowIndex]!;
      const updatedRow = hdr.map((h, i) => {
        if (h === "Updated") return new Date().toISOString().slice(0, 10);
        const dataKey = h.charAt(0).toLowerCase() + h.slice(1);
        const newVal = data?.[dataKey] ?? data?.[h];
        return newVal ?? existingRow[i] ?? "";
      });
      const updateRange = `${tab}!A${rowIndex + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: updateRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [updatedRow] },
      });
      return textResult(`Updated "${keyValue}" in ${tab}`);
    }

    return textResult(`Error: Unknown action "${action}"`);
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`);
  }
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

  const marketingKeywords: ToolEntry = {
    name: "marketing_keywords",
    source: "local",
    description:
      "CRUD operations on the Keywords tracking sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")],
        { description: "The operation to perform" },
      ),
      keyword: Type.Optional(Type.String({ description: "The keyword (required for add/update/remove)" })),
      data: Type.Optional(
        Type.Object({
          volume: Type.Optional(Type.String({ description: "Search volume" })),
          difficulty: Type.Optional(Type.String({ description: "Keyword difficulty" })),
          position: Type.Optional(Type.String({ description: "Current ranking position" })),
          notes: Type.Optional(Type.String({ description: "Additional notes" })),
        }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Keywords",
        headers: ["Keyword", "Volume", "Difficulty", "Position", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Keyword",
        keyValue: params.keyword as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  const marketingCompetitors: ToolEntry = {
    name: "marketing_competitors",
    source: "local",
    description:
      "CRUD operations on the Competitors tracking sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")],
        { description: "The operation to perform" },
      ),
      competitor: Type.Optional(Type.String({ description: "The competitor name (required for add/update/remove)" })),
      data: Type.Optional(
        Type.Object({
          url: Type.Optional(Type.String({ description: "Competitor URL" })),
          strengths: Type.Optional(Type.String({ description: "Competitor strengths" })),
          weaknesses: Type.Optional(Type.String({ description: "Competitor weaknesses" })),
          notes: Type.Optional(Type.String({ description: "Additional notes" })),
        }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Competitors",
        headers: ["Competitor", "URL", "Strengths", "Weaknesses", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Competitor",
        keyValue: params.competitor as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  const marketingContentCalendar: ToolEntry = {
    name: "marketing_content_calendar",
    source: "local",
    description:
      "CRUD operations on the Content Calendar sheet. Actions: list, add, update, remove.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")],
        { description: "The operation to perform" },
      ),
      entryId: Type.Optional(Type.String({ description: "The entry title (required for add/update/remove)" })),
      data: Type.Optional(
        Type.Object({
          title: Type.Optional(Type.String({ description: "Content title" })),
          type: Type.Optional(Type.String({ description: "Content type (blog, video, social, etc.)" })),
          keyword: Type.Optional(Type.String({ description: "Target keyword" })),
          status: Type.Optional(Type.String({ description: "Status (draft, in-progress, published)" })),
          publishDate: Type.Optional(Type.String({ description: "Planned publish date" })),
          assignee: Type.Optional(Type.String({ description: "Assigned person" })),
          notes: Type.Optional(Type.String({ description: "Additional notes" })),
        }),
      ),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      return sheetCrud({
        credentialStore: opts?.credentialStore,
        tab: "Content Calendar",
        headers: ["Title", "Type", "Keyword", "Status", "PublishDate", "Assignee", "Notes", "Updated"],
        action: params.action as string,
        keyField: "Title",
        keyValue: params.entryId as string | undefined,
        data: params.data as Record<string, string> | undefined,
      });
    },
  };

  return [seoAudit, marketingKeywords, marketingCompetitors, marketingContentCalendar];
}
