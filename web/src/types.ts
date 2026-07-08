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
  };
}

export interface CombinedItem extends MediaItem {
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
  error?: string;
  sessionExpired?: boolean;
  snapshot?: { count: number };
}
