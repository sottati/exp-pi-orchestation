import { Type, type Static } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { errorMessage } from "./errors";

const CREDENTIAL_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

const credentialFieldSchema = Type.Object({
  key: Type.String({
    description: "Credential field key (example: client_id, api_key, refresh_token).",
    minLength: 1,
  }),
  label: Type.Optional(Type.String({
    description: "Optional user-facing label shown in HITL UI.",
  })),
  secret: Type.Optional(Type.Boolean({
    description: "Whether the value should be entered in a masked input.",
  })),
  required: Type.Optional(Type.Boolean({
    description: "Whether the field is required. Defaults to true.",
  })),
});

const requestCredentialsParameters = Type.Object({
  domain: Type.String({
    description: "Credential domain namespace (for example: google, github, marketing).",
    minLength: 1,
  }),
  reason: Type.Optional(Type.String({
    description: "Why these credentials are needed. Displayed to the user in HITL.",
  })),
  fields: Type.Array(credentialFieldSchema, {
    description: "Fields to request from the user.",
    minItems: 1,
    maxItems: 24,
  }),
  values: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "Credential values collected during HITL approval.",
  })),
});
type RequestCredentialsParameters = Static<typeof requestCredentialsParameters>;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function createCredentialToolEntries(opts?: {
  credentialStore?: CredentialStore;
}): ToolEntry[] {
  const credentialStore = opts?.credentialStore;

  const requestCredentials: ToolEntry = {
    name: "request_credentials",
    source: "local",
    description: "Ask the user for credential values via HITL and store them in encrypted CredentialStore.",
    parameters: requestCredentialsParameters,
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as RequestCredentialsParameters;
      const domain = normalizeDomain(params.domain);

      if (!domain) {
        return textResult("Error: domain is required.");
      }
      if (!credentialStore?.enabled) {
        return textResult(
          "Error: Credential store is disabled. Set MASTER_PASSWORD before storing credentials.",
          { domain },
        );
      }

      try {
        const fields = params.fields ?? [];
        const seenKeys = new Set<string>();
        const normalizedFields = fields.map((field) => {
          const key = field.key.trim();
          if (!key || !CREDENTIAL_KEY_PATTERN.test(key)) {
            throw new Error(`Invalid credential field key '${field.key}'.`);
          }
          if (seenKeys.has(key)) {
            throw new Error(`Duplicate credential field key '${key}'.`);
          }
          seenKeys.add(key);
          return {
            key,
            label: field.label?.trim() || key,
            required: field.required ?? true,
          };
        });

        const valuesObject = (
          params.values && typeof params.values === "object"
            ? params.values
            : {}
        ) as Record<string, unknown>;

        const submitted: Record<string, string> = {};
        const missingRequired: string[] = [];
        for (const field of normalizedFields) {
          const value = valuesObject[field.key];
          if (typeof value !== "string" || value.trim() === "") {
            if (field.required) {
              missingRequired.push(field.key);
            }
            continue;
          }
          submitted[field.key] = value;
        }

        if (missingRequired.length > 0) {
          return textResult(
            `Missing required credential values: ${missingRequired.join(", ")}.`,
            { domain, missingRequired },
          );
        }
        if (Object.keys(submitted).length === 0) {
          return textResult("No credential values were provided.", { domain });
        }

        const existing = await credentialStore.get(domain) ?? {};
        const merged = { ...existing, ...submitted };
        await credentialStore.save(domain, merged);

        return textResult(
          `Stored credentials for '${domain}' (${Object.keys(submitted).length} field(s) updated).`,
          {
            domain,
            updatedFields: Object.keys(submitted).sort(),
            storedFieldCount: Object.keys(merged).length,
          },
        );
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`, { domain });
      }
    },
  };

  const getCredentialFields: ToolEntry = {
    name: "get_credential_fields",
    source: "local",
    description: "List the field names stored for a credential domain. Returns only key names (no values) so the agent knows which {{credential:fieldname}} placeholders are available for interact_page.",
    parameters: Type.Object({
      domain: Type.String({
        description: "Credential domain namespace (e.g. google.com, github.com, myapp).",
        minLength: 1,
      }),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, rawParams) => {
      const domain = normalizeDomain((rawParams as { domain: string }).domain);
      if (!credentialStore?.enabled) {
        return textResult("Credential store is disabled.", { domain });
      }
      try {
        const creds = await credentialStore.get(domain);
        if (!creds || Object.keys(creds).length === 0) {
          return textResult(`No credentials stored for domain '${domain}'.`, { domain, fields: [] });
        }
        const fields = Object.keys(creds).sort();
        return textResult(
          `Stored credential fields for '${domain}': ${fields.join(", ")}.\nUse {{credential:${fields[0]}}} placeholders in interact_page tasks.`,
          { domain, fields },
        );
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`, { domain });
      }
    },
  };

  return [requestCredentials, getCredentialFields];
}
