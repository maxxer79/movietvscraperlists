import type { ProviderStatus, SyncProgress } from "../types";

export function ProviderCard({
  provider,
  busy,
  syncProgress,
  onConnect,
  onScrape,
  onDisconnect,
  onToggleLog,
}: {
  provider: ProviderStatus;
  busy: boolean;
  syncProgress?: SyncProgress | null;
  onConnect: () => void;
  onScrape: () => void;
  onDisconnect: () => void;
  onToggleLog?: () => void;
}) {
  const last = provider.lastScrapedAt
    ? new Date(provider.lastScrapedAt).toLocaleString()
    : null;

  const elapsed =
    busy && syncProgress?.startedAt
      ? formatElapsed(Date.now() - Date.parse(syncProgress.startedAt))
      : null;

  return (
    <div className="panel provider-card">
      <div className="provider-top">
        <h3>{provider.name}</h3>
        {!provider.implemented ? (
          <span className="badge badge-soon">Coming soon</span>
        ) : provider.connected ? (
          <span className="badge badge-connected">Connected</span>
        ) : (
          <span className="badge badge-disconnected">Not connected</span>
        )}
      </div>

      {provider.notes ? <p className="provider-notes">{provider.notes}</p> : null}

      <div className="provider-meta">
        {busy && syncProgress ? (
          <div className="sync-progress">
            <p className="sync-status">
              <span className="spinner" /> {syncProgress.message}
              {elapsed ? ` · ${elapsed}` : ""}
              {syncProgress.itemsFound != null && syncProgress.itemsFound > 0
                ? ` · ${syncProgress.itemsFound} found`
                : ""}
            </p>
            <p className="sync-hint">
              Title count below won&apos;t update until sync finishes. Large libraries typically
              take 3–15 minutes (API path). If credentials must be captured first, allow up to
              ~45 minutes.
            </p>
            {syncProgress.logLines.length > 0 ? (
              <button type="button" className="sync-log-toggle" onClick={onToggleLog}>
                {syncProgress.showLog ? "Hide sync log" : "Show sync log"}
              </button>
            ) : null}
            {syncProgress.showLog && syncProgress.logLines.length > 0 ? (
              <pre className="sync-log">
                {syncProgress.logLines.join("\n")}
              </pre>
            ) : null}
          </div>
        ) : provider.itemCount > 0 ? (
          `${provider.itemCount} titles · last synced ${last}`
        ) : provider.implemented ? (
          "No titles synced yet"
        ) : (
          "Not available yet"
        )}
      </div>

      <div className="provider-actions">
        {!provider.implemented ? (
          <button className="btn btn-sm" disabled>
            Not available
          </button>
        ) : provider.connected ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={onScrape}
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="spinner" /> Syncing…
                </>
              ) : (
                "Sync library"
              )}
            </button>
            <button className="btn btn-danger btn-sm" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={onConnect} disabled={busy}>
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
