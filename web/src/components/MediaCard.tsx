import type { CombinedItem } from "../types";

export function MediaCard({
  item,
  showProvider,
}: {
  item: CombinedItem;
  showProvider: boolean;
}) {
  const is4k = item.quality?.includes("4K");
  return (
    <div className="media-card">
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
          {item.type !== "unknown" ? (
            <span className="chip chip-type">{item.type === "movie" ? "Movie" : "TV"}</span>
          ) : null}
          {item.year ? <span className="chip">{item.year}</span> : null}
          {item.quality ? (
            <span className={`chip ${is4k ? "chip-4k" : ""}`}>{item.quality}</span>
          ) : null}
          {showProvider ? (
            <span className="chip chip-provider">{item.providerName}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
