import type { MediaItem } from "../scrapers/types.js";

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS: Array<{ key: keyof MediaItem; header: string }> = [
  { key: "title", header: "Title" },
  { key: "type", header: "Type" },
  { key: "year", header: "Year" },
  { key: "quality", header: "Quality" },
  { key: "url", header: "URL" },
  { key: "posterUrl", header: "Poster" },
];

export function toCsv(items: MediaItem[], providerColumn?: string): string {
  const headers = [
    ...(providerColumn ? ["Provider"] : []),
    ...COLUMNS.map((c) => c.header),
  ];
  const rows = items.map((item) =>
    [
      ...(providerColumn ? [providerColumn] : []),
      ...COLUMNS.map((c) => csvCell(item[c.key])),
    ].join(",")
  );
  return [headers.join(","), ...rows].join("\r\n");
}
