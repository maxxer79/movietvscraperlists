import type { ProviderStatus } from "../types";

export function ProviderCard({
  provider,
  busy,
  onConnect,
  onScrape,
  onDisconnect,
}: {
  provider: ProviderStatus;
  busy: boolean;
  onConnect: () => void;
  onScrape: () => void;
  onDisconnect: () => void;
}) {
  const last = provider.lastScrapedAt
    ? new Date(provider.lastScrapedAt).toLocaleString()
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
        {provider.itemCount > 0
          ? `${provider.itemCount} titles · last synced ${last}`
          : provider.implemented
          ? "No titles synced yet"
          : "Not available yet"}
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
