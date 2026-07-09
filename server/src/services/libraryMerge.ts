import type { MediaItem } from "../scrapers/types.js";

export interface RetailerPresence {
  provider: string;
  providerName: string;
  itemId: string;
  quality?: string;
  url?: string;
}

export interface MergedItem {
  id: string;
  title: string;
  type: MediaItem["type"];
  year?: number;
  quality?: string;
  posterUrl?: string;
  url?: string;
  meta?: MediaItem["meta"];
  retailers: RetailerPresence[];
  /** Convenience: first retailer id (for legacy filters / delete default). */
  provider: string;
  providerName: string;
}

export interface ProviderLibraryInput {
  providerId: string;
  providerName: string;
  items: MediaItem[];
}

export function mergeLibraries(_inputs: ProviderLibraryInput[]): MergedItem[] {
  throw new Error("not implemented");
}
