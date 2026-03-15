import type { ThreadEnvelope } from "../../packages/core/contracts";
import type { ChatInspection } from "../../packages/core/runtime";

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) => {
            if (typeof item === "string") return item;
            if (
                typeof item === "object" &&
                item !== null &&
                (item as { type?: unknown }).type === "text" &&
                typeof (item as { text?: unknown }).text === "string"
            ) {
                return (item as { text: string }).text;
            }
            return "";
        })
        .join("")
        .trim();
}

function oneLine(text: string, max = 160): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function parseChatStatus(content: string): string | undefined {
    const match = content.match(/^\[chat_status:([^\]]+)\]\s+chatId=\S+\s+(.*)$/);
    if (!match) return undefined;
    return `${match[1]}: ${match[2]}`;
}

function turnKey(envelope: ThreadEnvelope): string {
    return `${envelope.runId}::${envelope.turnId}`;
}

export function chatSummary(details: ChatInspection): string {
    const status = details.chat?.status ?? details.summary?.status ?? "unknown";
    const agentId = details.chat?.agentId ?? details.summary?.agentId ?? "?";
    const attempts = details.chat ? ` attempts=${details.chat.attempts}/${details.chat.maxRetries + 1}` : "";
    return `chat=${details.queryId} agent=${agentId} status=${status}${attempts}`;
}

export function collectChatDelta(
    details: ChatInspection,
    printedEnvelopes: Set<string>,
    printedTurns: Set<string>,
): string[] {
    const lines: string[] = [];
    const sorted = details.threadMessages
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);

    for (const envelope of sorted) {
        if (!envelope.chatId || envelope.chatId !== details.queryId) continue;
        if (printedEnvelopes.has(envelope.envelopeId)) continue;
        printedEnvelopes.add(envelope.envelopeId);

        const currentTurnKey = turnKey(envelope);
        if (!printedTurns.has(currentTurnKey)) {
            printedTurns.add(currentTurnKey);
            lines.push(`[chat] ${details.queryId} turn run=${envelope.runId} turn=${envelope.turnId}`);
        }

        const raw = extractText(envelope.message.content);
        const statusLine = parseChatStatus(raw);
        if (statusLine) {
            lines.push(`[chat] ${details.queryId} ${statusLine}`);
            continue;
        }

        const from = envelope.fromAgentId;
        const to = envelope.toAgentId;
        const preview = oneLine(raw || "(sin texto)");
        lines.push(`[chat] ${details.queryId} ${from} -> ${to}: ${preview}`);
    }

    return lines;
}
