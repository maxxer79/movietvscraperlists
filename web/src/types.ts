export interface VersionInfo {
  version: string;
  build: number;
  releasedAt: string;
  codename?: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  implemented: boolean;
  notes?: string;
  connected: boolean;
  lastScrapedAt: string | null;
  itemCount: number;
}

export interface MediaItem {
  id: string;
  title: string;
  type: "movie" | "tv" | "unknown";
  year?: number;
  quality?: string;
  posterUrl?: string;
  url?: string;
  meta?: {
    contentKind?: string;
    isCollection?: boolean;
    collectionCount?: number;
    collectionItems?: Array<{
      id: string;
      title: string;
      year?: number;
      type?: string;
    }>;
    imdbId?: string;
    tmdbId?: string;
    moviesAnywhereId?: string;
    [key: string]: unknown;
  };
}

export interface RetailerPresence {
  provider: string;
  providerName: string;
  itemId: string;
  quality?: string;
  url?: string;
}

export interface MergedItem extends MediaItem {
  retailers: RetailerPresence[];
  /** Primary retailer (first); used as fallback. */
  provider: string;
  providerName: string;
}

/** Alias while migrating — same as MergedItem */
export type CombinedItem = MergedItem;

export interface RemovedItem {
  id: string;
  title: string;
  type: "movie" | "tv" | "unknown";
  year?: number;
  quality?: string;
  posterUrl?: string;
  url?: string;
  removedAt: string;
  reason: "sync" | "manual";
  lastSeenAt?: string;
  provider: string;
  providerName: string;
}

export type LoginStep =
  | { status: "success" }
  | { status: "need_input"; field: string; prompt: string }
  | { status: "error"; message: string };

export interface ScrapeJobStatus {
  jobId: string;
  status: "running" | "done" | "error";
  message: string;
  count: number | null;
  itemsFound?: number | null;
  logLines?: string[];
  error?: string;
  sessionExpired?: boolean;
  snapshot?: { count: number };
  startedAt?: string;
  finishedAt?: string | null;
}

export interface SyncProgress {
  message: string;
  itemsFound?: number | null;
  logLines: string[];
  startedAt?: string;
  showLog: boolean;
}
