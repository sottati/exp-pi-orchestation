import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStorePort } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleContactsToolOptions {
  credentialStore?: CredentialStorePort;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function formatContact(person: any) {
  const names = person.names ?? [];
  const emails = person.emailAddresses ?? [];
  const phones = person.phoneNumbers ?? [];
  const orgs = person.organizations ?? [];

  return {
    resourceName: person.resourceName,
    name: names[0]?.displayName ?? "(no name)",
    emails: emails.map((e: any) => e.value),
    phones: phones.map((p: any) => p.value),
    organization: orgs[0]?.name,
    title: orgs[0]?.title,
  };
}

export function createGoogleContactsToolEntries(opts?: GoogleContactsToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const contactsSearch: ToolEntry = {
    name: "contacts_search",
    source: "local",
    description: "Search Google Contacts by name, email, or phone number. Returns matching contacts with details.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (name, email, or phone)" }),
      maxResults: Type.Optional(Type.Number({ description: `Max results (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const query = params.query as string;
      const limit = Math.min((params.maxResults as number | undefined) ?? maxResults, maxResults);

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const people = google.people({ version: "v1", auth });

        const res = await people.people.searchContacts({
          query,
          pageSize: limit,
          readMask: "names,emailAddresses,phoneNumbers,organizations",
        });

        const contacts = (res.data.results ?? [])
          .filter((r: any) => r.person)
          .map((r: any) => formatContact(r.person));

        const resultData = { query, contactCount: contacts.length, contacts };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const contactsCreate: ToolEntry = {
    name: "contacts_create",
    source: "local",
    description: "Create a new Google Contact.",
    parameters: Type.Object({
      givenName: Type.String({ description: "First name" }),
      familyName: Type.Optional(Type.String({ description: "Last name" })),
      email: Type.Optional(Type.String({ description: "Email address" })),
      phone: Type.Optional(Type.String({ description: "Phone number" })),
      organization: Type.Optional(Type.String({ description: "Company/organization name" })),
      title: Type.Optional(Type.String({ description: "Job title" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const givenName = params.givenName as string;
      const familyName = params.familyName as string | undefined;
      const email = params.email as string | undefined;
      const phone = params.phone as string | undefined;
      const organization = params.organization as string | undefined;
      const title = params.title as string | undefined;

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const people = google.people({ version: "v1", auth });

        const contactBody: any = {
          names: [{ givenName, familyName }],
        };
        if (email) contactBody.emailAddresses = [{ value: email }];
        if (phone) contactBody.phoneNumbers = [{ value: phone }];
        if (organization || title) {
          contactBody.organizations = [{ name: organization, title }];
        }

        const res = await people.people.createContact({
          requestBody: contactBody,
        });

        const contact = formatContact(res.data);
        const resultData = { ...contact, created: true };
        return textResult(`Contact created: ${contact.name}${email ? ` (${email})` : ""}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [contactsSearch, contactsCreate];
}
