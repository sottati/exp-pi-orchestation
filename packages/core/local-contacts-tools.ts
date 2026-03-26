import { Type } from "@sinclair/typebox";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolEntry } from "./tool-registry";
import { createId, now } from "./ids";
import { errorMessage } from "./errors";

export interface LocalContactsToolOptions {
  dataDir?: string;
  fileName?: string;
  maxResults?: number;
}

interface LocalContact {
  contactId: string;
  name: string;
  givenName?: string;
  familyName?: string;
  emails: string[];
  phones: string[];
  organization?: string;
  title?: string;
  notes?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_DATA_DIR = ".runtime-data";
const DEFAULT_FILE_NAME = "secretary-contacts.json";
const DEFAULT_MAX_RESULTS = 200;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  return [...new Set(normalized)];
}

function parseContact(value: unknown): LocalContact | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const contactId = normalizeString(raw.contactId);
  if (!contactId) return undefined;

  const name = normalizeString(raw.name) ?? "(no name)";
  const givenName = normalizeString(raw.givenName);
  const familyName = normalizeString(raw.familyName);
  const emails = normalizeStringArray(raw.emails);
  const phones = normalizeStringArray(raw.phones);
  const organization = normalizeString(raw.organization);
  const title = normalizeString(raw.title);
  const notes = normalizeString(raw.notes);
  const tags = normalizeStringArray(raw.tags);
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : now();
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt;

  return {
    contactId,
    name,
    givenName,
    familyName,
    emails,
    phones,
    organization,
    title,
    notes,
    tags,
    createdAt,
    updatedAt,
  };
}

class LocalContactsStore {
  private readonly filePath: string;

  constructor(opts?: LocalContactsToolOptions) {
    const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;
    const fileName = opts?.fileName ?? DEFAULT_FILE_NAME;
    this.filePath = join(dataDir, fileName);
  }

  async list(): Promise<LocalContact[]> {
    try {
      const file = Bun.file(this.filePath);
      if (!(await file.exists())) return [];

      const parsed = JSON.parse(await file.text()) as unknown;
      if (!Array.isArray(parsed)) return [];

      const contacts = parsed
        .map((item) => parseContact(item))
        .filter((item): item is LocalContact => item !== undefined);

      return contacts.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async saveAll(contacts: LocalContact[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await Bun.write(this.filePath, JSON.stringify(contacts, null, 2));
  }
}

function matchesQuery(contact: LocalContact, queryLower: string): boolean {
  const searchable = [
    contact.contactId,
    contact.name,
    contact.givenName,
    contact.familyName,
    contact.organization,
    contact.title,
    contact.notes,
    ...contact.tags,
    ...contact.emails,
    ...contact.phones,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return searchable.some((value) => value.includes(queryLower));
}

export function createLocalContactsToolEntries(opts?: LocalContactsToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
  const store = new LocalContactsStore(opts);

  const contactsList: ToolEntry = {
    name: "contacts_list",
    source: "local",
    description: "List contacts from the internal secretary contact list.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Number({ description: "Offset for pagination (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: `Max contacts to return (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const contacts = await store.list();
        const offset = Math.max(0, Math.floor((params.offset as number | undefined) ?? 0));
        const requestedLimit = (params.limit as number | undefined) ?? maxResults;
        const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), maxResults);
        const page = contacts.slice(offset, offset + limit);

        const resultData = {
          totalContacts: contacts.length,
          offset,
          limit,
          returned: page.length,
          contacts: page,
        };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const contactsRead: ToolEntry = {
    name: "contacts_read",
    source: "local",
    description: "Read one contact from the internal secretary contact list by contactId.",
    parameters: Type.Object({
      contactId: Type.String({ description: "Contact ID to read" }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const contactId = params.contactId as string;

      try {
        const contacts = await store.list();
        const contact = contacts.find((item) => item.contactId === contactId);
        if (!contact) {
          return textResult(`Contact not found: ${contactId}`, { found: false, contactId });
        }

        const resultData = { found: true, contact };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const contactsSearch: ToolEntry = {
    name: "contacts_search",
    source: "local",
    description: "Search contacts in the internal secretary contact list by name, email, phone, tags, or notes.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: `Max results (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = (params.query as string).trim();
      if (!query) return textResult("Error: query is required.");
      const queryLower = query.toLowerCase();
      const limit = Math.min(
        Math.max(1, Math.floor((params.maxResults as number | undefined) ?? maxResults)),
        maxResults,
      );

      try {
        const contacts = await store.list();
        const matches = contacts.filter((contact) => matchesQuery(contact, queryLower)).slice(0, limit);
        const resultData = { query, contactCount: matches.length, contacts: matches };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const contactsCreate: ToolEntry = {
    name: "contacts_create",
    source: "local",
    description: "Create a new contact in the internal secretary contact list.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Full display name" })),
      givenName: Type.Optional(Type.String({ description: "First name" })),
      familyName: Type.Optional(Type.String({ description: "Last name" })),
      email: Type.Optional(Type.String({ description: "Primary email address" })),
      phone: Type.Optional(Type.String({ description: "Primary phone number" })),
      emails: Type.Optional(Type.Array(Type.String(), { description: "Additional email addresses" })),
      phones: Type.Optional(Type.Array(Type.String(), { description: "Additional phone numbers" })),
      organization: Type.Optional(Type.String({ description: "Company/organization name" })),
      title: Type.Optional(Type.String({ description: "Job title" })),
      notes: Type.Optional(Type.String({ description: "Notes" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags/labels" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      try {
        const givenName = normalizeString(params.givenName);
        const familyName = normalizeString(params.familyName);
        const explicitName = normalizeString(params.name);
        const resolvedName = explicitName ?? [givenName, familyName].filter(Boolean).join(" ").trim();

        const primaryEmail = normalizeString(params.email);
        const primaryPhone = normalizeString(params.phone);
        const emails = [...new Set([
          ...normalizeStringArray(params.emails),
          ...(primaryEmail ? [primaryEmail] : []),
        ])];
        const phones = [...new Set([
          ...normalizeStringArray(params.phones),
          ...(primaryPhone ? [primaryPhone] : []),
        ])];

        if (!resolvedName && emails.length === 0 && phones.length === 0) {
          return textResult("Error: a contact needs at least a name, email, or phone.");
        }

        const contact: LocalContact = {
          contactId: createId("contact"),
          name: resolvedName || "(no name)",
          givenName,
          familyName,
          emails,
          phones,
          organization: normalizeString(params.organization),
          title: normalizeString(params.title),
          notes: normalizeString(params.notes),
          tags: normalizeStringArray(params.tags),
          createdAt: now(),
          updatedAt: now(),
        };

        const contacts = await store.list();
        contacts.unshift(contact);
        await store.saveAll(contacts);

        const resultData = { created: true, contact };
        return textResult(`Contact saved: ${contact.name} (id: ${contact.contactId})`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const contactsDelete: ToolEntry = {
    name: "contacts_delete",
    source: "local",
    description: "Delete a contact from the internal secretary contact list by contactId.",
    parameters: Type.Object({
      contactId: Type.String({ description: "Contact ID to delete" }),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const contactId = params.contactId as string;

      try {
        const contacts = await store.list();
        const index = contacts.findIndex((item) => item.contactId === contactId);
        if (index < 0) {
          return textResult(`Contact not found: ${contactId}`, { deleted: false, contactId });
        }

        const [removed] = contacts.splice(index, 1);
        if (!removed) {
          return textResult(`Contact not found: ${contactId}`, { deleted: false, contactId });
        }
        await store.saveAll(contacts);

        const resultData = { deleted: true, contact: removed };
        return textResult(`Contact deleted: ${removed.name} (${removed.contactId})`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [contactsList, contactsRead, contactsSearch, contactsCreate, contactsDelete];
}
