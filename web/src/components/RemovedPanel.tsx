import type { RemovedItem } from "../types";

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function RemovedPanel({
  items,
  onRestore,
}: {
  items: RemovedItem[];
  onRestore: (item: RemovedItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="removed-empty">
        No removals yet. After the next Sync, titles that disappear from a service will show up here
        with the date and time they were first missing.
      </div>
    );
  }

  return (
    <div className="removed-list">
      {items.map((item) => (
        <div key={`${item.provider}:${item.id}:${item.removedAt}`} className="removed-row">
          <div className="removed-main">
            <p className="removed-title">{item.title}</p>
            <div className="removed-meta">
              <span className="chip chip-type">
                {item.type === "movie" ? "Movie" : item.type === "tv" ? "TV" : "Unknown"}
              </span>
              {item.year ? <span className="chip">{item.year}</span> : null}
              <span className="chip chip-provider">{item.providerName}</span>
              <span className={`chip ${item.reason === "sync" ? "chip-removed" : "chip-manual"}`}>
                {item.reason === "sync" ? "Removed by service" : "Deleted manually"}
              </span>
            </div>
            <p className="removed-when">
              {item.reason === "sync" ? "First missing" : "Deleted"} {formatWhen(item.removedAt)}
              {item.lastSeenAt ? ` · last seen ${formatWhen(item.lastSeenAt)}` : ""}
            </p>
          </div>
          {item.reason === "manual" ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRestore(item)}
              title="Allow this title to return on the next Sync"
            >
              Undo hide
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
