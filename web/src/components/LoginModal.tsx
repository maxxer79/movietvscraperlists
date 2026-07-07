import { useState } from "react";
import { api } from "../api";
import type { LoginStep, ProviderStatus } from "../types";

type Phase = "credentials" | "code" | "working";

export function LoginModal({
  provider,
  onClose,
  onConnected,
}: {
  provider: ProviderStatus;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [field, setField] = useState("code");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleStep(step: LoginStep, id?: string) {
    if (step.status === "success") {
      onConnected();
      return;
    }
    if (step.status === "need_input") {
      if (id) setLoginId(id);
      setPhase("code");
      setPrompt(step.prompt);
      setField(step.field);
      setCode("");
      setError("");
      return;
    }
    setError(step.message);
    setPhase(id ? "credentials" : "code");
  }

  async function submitCredentials() {
    setBusy(true);
    setError("");
    try {
      const { loginId: id, step } = await api.startLogin(
        provider.id,
        username,
        password
      );
      setLoginId(id);
      handleStep(step, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setError("");
    try {
      const { step } = await api.submitLogin(provider.id, loginId, code, field);
      handleStep(step);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect {provider.name}</h2>
        <p className="sub">
          You log in through the app once. Your session is saved (encrypted) and
          reused for future scrapes — including any 2-factor code.
        </p>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {phase === "code" ? (
          <>
            <div className="alert alert-info">{prompt}</div>
            <div className="field">
              <label>Verification code</label>
              <input
                className="input"
                value={code}
                autoFocus
                inputMode="numeric"
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && code && submitCode()}
                placeholder="123456"
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={submitCode}
                disabled={busy || !code}
              >
                {busy ? <span className="spinner" /> : "Verify"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Email / username</label>
              <input
                className="input"
                value={username}
                autoFocus
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                className="input"
                type="password"
                value={password}
                autoComplete="off"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && username && password && submitCredentials()
                }
                placeholder="••••••••"
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={submitCredentials}
                disabled={busy || !username || !password}
              >
                {busy ? <span className="spinner" /> : "Sign in"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
