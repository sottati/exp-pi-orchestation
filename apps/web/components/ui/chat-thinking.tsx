import { DithieSprite } from "../../dithie-sprite";
import { cn } from "../../lib/utils";
import type { ThinkingTraceBlock } from "../../ui-state";

export function visibleThinkingLines(lines: string[], collapsed: boolean): string[] {
  void collapsed;
  return lines;
}

export function extractThinkingHeadingText(line: string): string | undefined {
  const trimmed = line.trim();

  const boldTitleMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
  if (boldTitleMatch) {
    return boldTitleMatch[1]!.trim();
  }

  const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return headingMatch[1]!.trim();
  }

  return undefined;
}

export function splitThinkingTitle(lines: string[]): {
  title?: string;
  bodyLines: string[];
} {
  const [firstLine, ...rest] = lines;
  if (!firstLine) {
    return { bodyLines: [] };
  }

  if (firstLine === "thinking..." && rest.length === 0) {
    return { bodyLines: [] };
  }

  const title = extractThinkingHeadingText(firstLine);
  if (title) {
    return {
      title,
      bodyLines: rest,
    };
  }

  return { bodyLines: lines };
}

function ThinkingStatusIcon({ status }: { status: ThinkingTraceBlock["status"] }) {
  if (status === "running") {
    return <span className="inline-block h-3 w-3 animate-spin rounded-full border border-theme-text-soft border-t-transparent" aria-hidden />;
  }

  if (status === "error") {
    return (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-theme-button-foreground text-[8px] leading-none text-theme-button-foreground" aria-hidden>
        x
      </span>
    );
  }

  return <span className="inline-block h-2.5 w-2.5 rounded-full bg-theme-text-soft" aria-hidden />;
}

export function ThinkingRow({ lines }: { lines: string[] }) {
  return (
    <div
      className="flex max-w-[90%] flex-row items-start gap-3 self-start px-1 pt-2 pb-3"
      aria-live="polite"
      aria-busy="true"
    >
      <DithieSprite size={32} state="thinking" />
      <div className="flex min-w-0 flex-col gap-1 pt-1">
        <span className="animate-dot-pulse text-[10px] uppercase tracking-[0.08em] text-theme-text-soft">
          thinking
        </span>
        {lines.map((line, index) => (
          <div key={`live-thinking-${index}`} className="max-w-full text-[11px] whitespace-pre-wrap break-words text-theme-text-soft">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ThinkingTraceBlockComponent({
  block,
}: {
  block: ThinkingTraceBlock;
}) {
  const lines = visibleThinkingLines(block.lines, block.collapsed);
  const { title, bodyLines } = splitThinkingTitle(lines);

  return (
    <div className="my-2 flex max-w-[92%] flex-row items-stretch gap-3 self-start px-1 text-[11px] opacity-85">
      <div className="mt-1 w-px shrink-0 self-stretch bg-theme-border-subdued" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 pb-2 text-[10px] tracking-[0.08em]">
          <ThinkingStatusIcon status={block.status} />
          <span className="text-theme-text-soft">thinking</span>
          {title && (
            <span className={cn(
              "text-[11px] font-medium normal-case tracking-normal text-theme-text",
              block.status === "error" && "text-theme-button-foreground",
            )}
            >
              {title}
            </span>
          )}
        </div>
        <div className="space-y-1 pr-2">
          {bodyLines.map((line, index) => {
            const sectionTitle = extractThinkingHeadingText(line);
            if (sectionTitle) {
              return (
                <div
                  key={`${block.runId}-${index}`}
                  className="pt-3 text-[11px] font-medium italic tracking-[0.04em] text-theme-text"
                >
                  {sectionTitle}
                </div>
              );
            }

            return (
              <div key={`${block.runId}-${index}`} className="whitespace-pre-wrap break-words leading-[1.7] text-theme-text-soft">
                {line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
