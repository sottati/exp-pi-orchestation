import { useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import { useRuntime } from "../runtime-context";
import { AppHeader } from "../components/header";

interface CredentialPromptField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}

interface CredentialPrompt {
  domain: string;
  reason?: string;
  fields: CredentialPromptField[];
  values: Record<string, string>;
}

function parseCredentialPrompt(params: Record<string, unknown>): CredentialPrompt | null {
  const domain = typeof params.domain === "string" ? params.domain.trim() : "";
  if (!domain) return null;

  const maybeFields = params.fields;
  if (!Array.isArray(maybeFields) || maybeFields.length === 0) return null;

  const fields: CredentialPromptField[] = [];
  for (const rawField of maybeFields) {
    if (typeof rawField !== "object" || rawField === null) continue;
    const field = rawField as {
      key?: unknown;
      label?: unknown;
      required?: unknown;
      secret?: unknown;
    };
    const key = typeof field.key === "string" ? field.key.trim() : "";
    if (!key) continue;
    fields.push({
      key,
      label: typeof field.label === "string" && field.label.trim() ? field.label.trim() : key,
      required: typeof field.required === "boolean" ? field.required : true,
      secret: Boolean(field.secret),
    });
  }

  if (fields.length === 0) return null;

  const values: Record<string, string> = {};
  const rawValues = params.values;
  if (typeof rawValues === "object" && rawValues !== null) {
    const valuesObject = rawValues as Record<string, unknown>;
    for (const field of fields) {
      const value = valuesObject[field.key];
      if (typeof value === "string") {
        values[field.key] = value;
      }
    }
  }

  const reason = typeof params.reason === "string" ? params.reason : undefined;
  return { domain, reason, fields, values };
}

export function DashboardLayout() {
  const { state, respondToHitl } = useRuntime();
  const activeHitlRequest = state.hitlQueue[0];
  const credentialPrompt = useMemo(() => {
    if (!activeHitlRequest || activeHitlRequest.toolName !== "request_credentials") return null;
    return parseCredentialPrompt(activeHitlRequest.params);
  }, [activeHitlRequest]);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialError, setCredentialError] = useState<string>("");

  useEffect(() => {
    if (!activeHitlRequest || !credentialPrompt) {
      setCredentialValues({});
      setCredentialError("");
      return;
    }
    const nextValues: Record<string, string> = {};
    for (const field of credentialPrompt.fields) {
      nextValues[field.key] = credentialPrompt.values[field.key] ?? "";
    }
    setCredentialValues(nextValues);
    setCredentialError("");
  }, [activeHitlRequest?.reqId, credentialPrompt]);

  const approveHitl = () => {
    if (!activeHitlRequest) return;

    if (!credentialPrompt) {
      respondToHitl(activeHitlRequest.reqId, true);
      return;
    }

    const missing = credentialPrompt.fields
      .filter((field) => field.required && !(credentialValues[field.key] ?? "").trim())
      .map((field) => field.key);
    if (missing.length > 0) {
      setCredentialError(`Missing required fields: ${missing.join(", ")}`);
      return;
    }

    const values: Record<string, string> = {};
    for (const field of credentialPrompt.fields) {
      const value = credentialValues[field.key] ?? "";
      if (value.trim() !== "") {
        values[field.key] = value;
      }
    }

    respondToHitl(activeHitlRequest.reqId, true, {
      ...activeHitlRequest.params,
      values,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <AppHeader />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      {activeHitlRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex w-full max-w-2xl flex-col gap-3 border border-theme-border bg-theme-surface p-4 shadow-2xl">
            <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">approval required</div>
            <div className="text-[12px] text-theme-text-soft">
              {activeHitlRequest.agentId} wants to run <code>{activeHitlRequest.toolName}</code>.
            </div>
            {activeHitlRequest.reason && (
              <div className="text-[12px] text-theme-text-soft">{activeHitlRequest.reason}</div>
            )}
            {credentialPrompt?.reason && (
              <div className="text-[12px] text-theme-text-soft">{credentialPrompt.reason}</div>
            )}
            <div className="flex gap-3 text-[10px] uppercase tracking-[0.08em] text-theme-text-muted">
              <span>timeout: {Math.max(1, Math.floor(activeHitlRequest.timeout / 1000))}s</span>
              {state.hitlQueue.length > 1 && <span>pending: {state.hitlQueue.length}</span>}
            </div>
            {credentialPrompt ? (
              <>
                <div className="text-[10px] uppercase tracking-[0.08em] text-theme-text-muted">
                  credentials for domain: {credentialPrompt.domain}
                </div>
                <div className="max-h-72 overflow-auto border border-theme-border bg-theme-input p-3">
                  <div className="flex flex-col gap-3">
                    {credentialPrompt.fields.map((field) => (
                      <label key={field.key} className="flex flex-col gap-1 text-[12px] text-theme-text">
                        <span className="text-[11px] uppercase tracking-[0.08em] text-theme-text-soft">
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        <input
                          type={field.secret ? "password" : "text"}
                          className="border border-theme-border bg-theme-surface px-2 py-1 text-[12px] text-theme-text outline-none focus:border-theme-text"
                          value={credentialValues[field.key] ?? ""}
                          onChange={(event) => {
                            setCredentialError("");
                            setCredentialValues((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }));
                          }}
                          autoComplete="off"
                        />
                      </label>
                    ))}
                  </div>
                </div>
                {credentialError && (
                  <div className="text-[12px] text-theme-text-muted">{credentialError}</div>
                )}
              </>
            ) : (
              <>
                <div className="text-[10px] uppercase tracking-[0.08em] text-theme-text-muted">params</div>
                <pre className="max-h-72 overflow-auto border border-theme-border bg-theme-input p-3 text-[12px] whitespace-pre-wrap break-words text-theme-text">
                  {JSON.stringify(activeHitlRequest.params, null, 2)}
                </pre>
              </>
            )}
            <div className="flex justify-end gap-2 max-sm:flex-col">
              <button
                type="button"
                className="border border-theme-text px-3 py-2 text-[12px] text-theme-text hover:bg-theme-surface-hover"
                onClick={approveHitl}
              >
                {credentialPrompt ? "Save & Allow" : "Allow (y)"}
              </button>
              <button
                type="button"
                className="border border-theme-border-subdued px-3 py-2 text-[12px] text-theme-text-soft hover:bg-theme-surface-hover"
                onClick={() => respondToHitl(activeHitlRequest.reqId, false)}
              >
                Don&apos;t Allow (n)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
