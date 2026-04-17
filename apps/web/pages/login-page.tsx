import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { DithieSprite } from "../dithie-sprite";
import { readAuthToken } from "../auth-token";
import { getSupabaseBrowserClient } from "../supabase-browser";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authReady, setAuthReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = readAuthToken();
      if (token) {
        navigate("/", { replace: true });
        return;
      }
      const client = await getSupabaseBrowserClient();
      if (cancelled) return;
      setAuthReady(!!client);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const client = await getSupabaseBrowserClient();
      if (!client) {
        setError("Supabase auth config is missing in backend env.");
        return;
      }
      const { data, error: signInError } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      const accessToken = data.session?.access_token?.trim();
      if (accessToken) {
        window.localStorage.setItem("PI_AUTH_TOKEN", accessToken);
      }
      navigate("/", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-theme-bg px-4">
      <div className="w-full max-w-sm border border-theme-border bg-theme-surface p-5">
        <div className="mb-4 flex items-center gap-3">
          <DithieSprite size={32} state="idle" />
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-theme-text">dithie</div>
            <div className="text-[10px] text-theme-text-soft"></div>
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.08em] text-theme-text-soft">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              className="border border-theme-border bg-theme-input px-2 py-2 text-[12px] normal-case tracking-normal text-theme-text outline-none focus:border-theme-text"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.08em] text-theme-text-soft">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              className="border border-theme-border bg-theme-input px-2 py-2 text-[12px] normal-case tracking-normal text-theme-text outline-none focus:border-theme-text"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {authReady === false && (
            <p className="text-[12px] text-theme-text-muted">
              Missing auth config. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in backend env.
            </p>
          )}
          {error && <p className="text-[12px] text-theme-text-muted">{error}</p>}

          <button
            type="submit"
            disabled={busy || authReady === false}
            className="mt-1 border border-theme-text bg-theme-surface px-3 py-2 text-[11px] uppercase tracking-[0.1em] text-theme-text hover:bg-theme-surface-hover disabled:cursor-not-allowed disabled:border-theme-border disabled:text-theme-text-muted"
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
