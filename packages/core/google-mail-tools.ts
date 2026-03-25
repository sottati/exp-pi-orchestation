import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleMailToolOptions {
  credentialStore?: CredentialStore;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 20;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractBody(payload: any): string {
  // Simple text/plain body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);
    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      // Strip HTML tags for a rough text extraction
      return decodeBase64Url(htmlPart.body.data).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

// ─── Read tools (for secretary agent) ────────────────────────────────

export function createGmailReadToolEntries(opts?: GoogleMailToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const gmailSearch: ToolEntry = {
    name: "gmail_search",
    source: "local",
    description: "Search Gmail for messages matching a query. Returns message IDs, subjects, senders, dates, and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Gmail search query (same syntax as Gmail search bar, e.g. 'from:boss is:unread', 'subject:invoice after:2024/01/01')" }),
      maxResults: Type.Optional(Type.Number({ description: `Max messages to return (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = params.query as string;
      const limit = Math.min((params.maxResults as number | undefined) ?? maxResults, maxResults);

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const gmail = google.gmail({ version: "v1", auth });

        const listRes = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: limit,
        });

        const messageIds = listRes.data.messages ?? [];
        if (messageIds.length === 0) {
          return textResult(JSON.stringify({ query, messageCount: 0, messages: [] }));
        }

        // Fetch metadata for each message
        const messages = await Promise.all(
          messageIds.map(async (m) => {
            const msg = await gmail.users.messages.get({
              userId: "me",
              id: m.id!,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            });
            const headers = msg.data.payload?.headers ?? [];
            return {
              id: msg.data.id,
              threadId: msg.data.threadId,
              from: getHeader(headers, "From"),
              to: getHeader(headers, "To"),
              subject: getHeader(headers, "Subject"),
              date: getHeader(headers, "Date"),
              snippet: msg.data.snippet,
              labelIds: msg.data.labelIds,
            };
          }),
        );

        const resultData = { query, messageCount: messages.length, messages };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const gmailRead: ToolEntry = {
    name: "gmail_read",
    source: "local",
    description: "Read the full content of a Gmail message by ID. Returns headers, body text, and attachment info.",
    parameters: Type.Object({
      messageId: Type.String({ description: "The message ID (from gmail_search results)" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const messageId = params.messageId as string;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const gmail = google.gmail({ version: "v1", auth });

        const msg = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });

        const headers = msg.data.payload?.headers ?? [];
        const body = extractBody(msg.data.payload);

        // List attachments
        const attachments: { filename: string; mimeType: string; size: number }[] = [];
        const parts = msg.data.payload?.parts ?? [];
        for (const part of parts) {
          if (part.filename && part.body?.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType ?? "application/octet-stream",
              size: part.body.size ?? 0,
            });
          }
        }

        const resultData = {
          id: msg.data.id,
          threadId: msg.data.threadId,
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          subject: getHeader(headers, "Subject"),
          date: getHeader(headers, "Date"),
          labelIds: msg.data.labelIds,
          body,
          attachments,
        };
        return textResult(body || "(empty body)", resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [gmailSearch, gmailRead];
}

// ─── Write tools (for writer agent) ──────────────────────────────────

export function createGmailWriteToolEntries(opts?: GoogleMailToolOptions): ToolEntry[] {

  const gmailSend: ToolEntry = {
    name: "gmail_send",
    source: "local",
    description: "Send an email from the user's Gmail account.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient email address(es), comma-separated" }),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.String({ description: "Email body (plain text)" }),
      cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated" })),
      bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated" })),
      replyToMessageId: Type.Optional(Type.String({ description: "Message ID to reply to (sets In-Reply-To and References headers)" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const to = params.to as string;
      const subject = params.subject as string;
      const body = params.body as string;
      const cc = params.cc as string | undefined;
      const bcc = params.bcc as string | undefined;
      const replyToMessageId = params.replyToMessageId as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const gmail = google.gmail({ version: "v1", auth });

        let headers = `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n`;
        if (cc) headers += `Cc: ${cc}\n`;
        if (bcc) headers += `Bcc: ${bcc}\n`;

        let threadId: string | undefined;
        if (replyToMessageId) {
          // Get the original message for threading
          const orig = await gmail.users.messages.get({
            userId: "me",
            id: replyToMessageId,
            format: "metadata",
            metadataHeaders: ["Message-ID"],
          });
          const origMsgId = getHeader(orig.data.payload?.headers ?? [], "Message-ID");
          if (origMsgId) {
            headers += `In-Reply-To: ${origMsgId}\nReferences: ${origMsgId}\n`;
          }
          threadId = orig.data.threadId ?? undefined;
        }

        const raw = Buffer.from(`${headers}\n${body}`).toString("base64url");

        const sendRes = await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw, threadId },
        });

        const resultData = {
          messageId: sendRes.data.id,
          threadId: sendRes.data.threadId,
          to,
          subject,
        };
        return textResult(`Email sent to ${to}: "${subject}"`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const gmailDraft: ToolEntry = {
    name: "gmail_draft",
    source: "local",
    description: "Create a draft email in Gmail (does not send it).",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient email address(es)" }),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.String({ description: "Email body (plain text)" }),
      cc: Type.Optional(Type.String({ description: "CC recipients" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const to = params.to as string;
      const subject = params.subject as string;
      const body = params.body as string;
      const cc = params.cc as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const gmail = google.gmail({ version: "v1", auth });

        let headers = `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n`;
        if (cc) headers += `Cc: ${cc}\n`;

        const raw = Buffer.from(`${headers}\n${body}`).toString("base64url");

        const draftRes = await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw } },
        });

        const resultData = {
          draftId: draftRes.data.id,
          messageId: draftRes.data.message?.id,
          to,
          subject,
        };
        return textResult(`Draft created: "${subject}" to ${to}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [gmailSend, gmailDraft];
}
