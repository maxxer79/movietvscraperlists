import { useState } from "react";
import { api, setToken } from "../api";

export function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const { token } = await api.login(password);
      setToken(token);
      onUnlock();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="modal" style={{ maxWidth: 380 }}>
        <h2>🔒 Locked</h2>
        <p className="sub">Enter the app password to continue.</p>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="field">
          <input
            className="input"
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && submit()}
            placeholder="Password"
          />
        </div>
        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={submit}
          disabled={busy || !password}
        >
          {busy ? <span className="spinner" /> : "Unlock"}
        </button>
      </div>
    </div>
  );
}
