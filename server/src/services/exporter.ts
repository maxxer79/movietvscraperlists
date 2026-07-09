import type { MediaItem } from "../scrapers/types.js";
import type { MergedItem } from "./libraryMerge.js";

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvExportItem {
  title: string;
  type: string;
  year?: number;
  quality?: string;
  url?: string;
  posterUrl?: string;
  providerName?: string;
  /** Set when this row came from expanding a bundle/collection. */
  fromCollection?: string;
}

/**
 * Flatten library items for CSV: each title in a bundle/collection becomes its own row.
 * Parent collection rows are omitted when children were expanded.
 */
export function flattenItemsForCsv(
  items: Array<
    MediaItem & {
      providerName?: string;
      meta?: {
        isCollection?: boolean;
        contentKind?: string;
        collectionItems?: Array<{
          id: string;
          title: string;
          year?: number;
          type?: string;
        }>;
      };
    }
  >
): CsvExportItem[] {
  const out: CsvExportItem[] = [];
  for (const item of items) {
    const children = item.meta?.collectionItems;
    if (children && children.length > 0) {
      for (const child of children) {
        out.push({
          title: child.title,
          type: child.type || item.type,
          year: child.year,
          quality: item.quality,
          url: item.url,
          posterUrl: undefined,
          providerName: item.providerName,
          fromCollection: item.title,
        });
      }
      continue;
    }
    out.push({
      title: item.title,
      type: item.type,
      year: item.year,
      quality: item.quality,
      url: item.url,
      posterUrl: item.posterUrl,
      providerName: item.providerName,
    });
  }
  return out;
}

export function toCsv(
  items: Array<MediaItem & { providerName?: string }>,
  includeProvider = false
): string {
  const flat = flattenItemsForCsv(items);
  const headers = [
    ...(includeProvider ? ["Provider"] : []),
    "Title",
    "Type",
    "Year",
    "Quality",
    "URL",
    "Poster",
    "From Collection",
  ];
  const rows = flat.map((item) =>
    [
      ...(includeProvider ? [csvCell(item.providerName)] : []),
      csvCell(item.title),
      csvCell(item.type),
      csvCell(item.year),
      csvCell(item.quality),
      csvCell(item.url),
      csvCell(item.posterUrl),
      csvCell(item.fromCollection),
    ].join(",")
  );
  return [headers.join(","), ...rows].join("\r\n");
}

export function toMergedCsv(items: MergedItem[]): string {
  const headers = ["Title", "Type", "Year", "Quality", "Retailers", "URL", "Poster"];
  const rows = items.map((item) =>
    [
      csvCell(item.title),
      csvCell(item.type),
      csvCell(item.year),
      csvCell(item.quality),
      csvCell(item.retailers.map((r) => r.providerName).join("; ")),
      csvCell(item.url),
      csvCell(item.posterUrl),
    ].join(",")
  );
  return [headers.join(","), ...rows].join("\r\n");
}
