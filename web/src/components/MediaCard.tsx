import type { CombinedItem } from "../types";
import { useState } from "react";

export function MediaCard({
  item,
  showProvider,
  onDelete,
}: {
  item: CombinedItem;
  showProvider: boolean;
  onDelete?: (item: CombinedItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const is4k = item.quality?.includes("4K");
  const isCollection = item.meta?.isCollection || item.meta?.contentKind === "bundle";
  const collectionItems = item.meta?.collectionItems ?? [];

  return (
    <div className={`media-card ${isCollection ? "media-card-collection" : ""}`}>
      {onDelete ? (
        <button
          type="button"
          className="media-delete"
          title="Remove from library"
          aria-label={`Remove ${item.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item);
          }}
        >
          ×
        </button>
      ) : null}
      {item.posterUrl ? (
        <img
          className="poster"
          src={item.posterUrl}
          alt={item.title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="poster-fallback">🎬</div>
      )}
      <div className="media-body">
        <p className="media-title" title={item.title}>
          {item.title}
        </p>
        <div className="media-sub">
          {isCollection ? (
            <span className="chip chip-collection">Collection</span>
          ) : null}
          {item.type !== "unknown" ? (
            <span className="chip chip-type">{item.type === "movie" ? "Movie" : "TV"}</span>
          ) : null}
          {item.year ? <span className="chip">{item.year}</span> : null}
          {item.quality ? (
            <span className={`chip ${is4k ? "chip-4k" : ""}`}>{item.quality}</span>
          ) : null}
          {showProvider
            ? (item.retailers ?? []).map((r) => (
                <span
                  key={`${r.provider}:${r.itemId}`}
                  className="chip chip-provider"
                  title={r.quality}
                >
                  {r.providerName}
                  {r.quality ? ` · ${r.quality}` : ""}
                </span>
              ))
            : null}
        </div>
        {isCollection && collectionItems.length > 0 ? (
          <div className="collection-block">
            <button
              type="button"
              className="collection-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide" : "Show"} {collectionItems.length} titles in this collection
            </button>
            {expanded ? (
              <ul className="collection-list">
                {collectionItems.map((child) => (
                  <li key={child.id}>
                    {child.title}
                    {child.year ? ` (${child.year})` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : isCollection ? (
          <p className="collection-hint">Collection — sync again to load included titles</p>
        ) : null}
      </div>
    </div>
  );
}
