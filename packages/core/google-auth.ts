import { google } from "googleapis";
import type { CredentialStorePort } from "./credential-store";

export const GOOGLE_CREDENTIAL_DOMAIN = "google";

export interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/**
 * Build an authenticated OAuth2 client from the credential store.
 * Falls back to environment variables if no store entry exists.
 */
export async function getGoogleAuth(opts?: { credentialStore?: CredentialStorePort }) {
  let creds: GoogleCredentials | undefined;

  // Try credential store first
  if (opts?.credentialStore?.enabled) {
    const stored = await opts.credentialStore.get(GOOGLE_CREDENTIAL_DOMAIN);
    if (stored?.client_id && stored?.client_secret && stored?.refresh_token) {
      creds = stored as unknown as GoogleCredentials;
    }
  }

  // Fall back to env vars
  if (!creds) {
    const client_id = process.env.GOOGLE_CLIENT_ID;
    const client_secret = process.env.GOOGLE_CLIENT_SECRET;
    const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
    if (client_id && client_secret && refresh_token) {
      creds = { client_id, client_secret, refresh_token };
    }
  }

  if (!creds) {
    throw new Error(
      "Google credentials not found. Store them with the credential store (domain: 'google') " +
      "or set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN environment variables."
    );
  }

  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2.setCredentials({ refresh_token: creds.refresh_token });
  return oauth2;
}

