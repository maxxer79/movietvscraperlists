import { Router } from "express";
import { enabledProviders, getProvider } from "../scrapers/registry.js";
import {
  deleteLibraryItem,
  loadLibrary,
  restoreLibraryItem,
  type RemovedItem,
} from "../services/libraryStore.js";
import { toCsv } from "../services/exporter.js";
import type { MediaItem } from "../scrapers/types.js";

export const libraryRouter = Router();

interface CombinedItem extends MediaItem {
  provider: string;
  providerName: string;
}

interface CombinedRemoved extends RemovedItem {
  provider: string;
  providerName: string;
}

function collectAll(): CombinedItem[] {
  const out: CombinedItem[] = [];
  for (const p of enabledProviders()) {
    const lib = loadLibrary(p.id);
    if (!lib) continue;
    for (const item of lib.items) {
      out.push({ ...item, provider: p.id, providerName: p.name });
    }
  }
  return out;
}

function collectRemoved(): CombinedRemoved[] {
  const out: CombinedRemoved[] = [];
  for (const p of enabledProviders()) {
    const lib = loadLibrary(p.id);
    if (!lib?.removed?.length) continue;
    for (const item of lib.removed) {
      out.push({ ...item, provider: p.id, providerName: p.name });
    }
  }
  out.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  return out;
}

// Combined library across all providers.
libraryRouter.get("/", (_req, res) => {
  const items = collectAll();
  const removed = collectRemoved();
  res.json({ count: items.length, items, removedCount: removed.length, removed });
});

// Titles that left a provider library (or were manually deleted).
libraryRouter.get("/removed", (_req, res) => {
  const removed = collectRemoved();
  res.json({ count: removed.length, removed });
});

// Export: /api/library/export?format=csv|json&provider=fandango(optional)
libraryRouter.get("/export", (req, res) => {
  const format = (req.query.format as string) || "csv";
  const providerId = req.query.provider as string | undefined;

  let items: CombinedItem[];
  if (providerId) {
    const provider = getProvider(providerId);
    if (!provider) return res.status(404).json({ error: "Unknown provider" });
    const lib = loadLibrary(provider.id);
    items = (lib?.items ?? []).map((i) => ({
      ...i,
      provider: provider.id,
      providerName: provider.name,
    }));
  } else {
    items = collectAll();
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const base = providerId ? `library-${providerId}-${stamp}` : `library-all-${stamp}`;

  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`);
    return res.send(JSON.stringify(items, null, 2));
  }

  // Expand bundles into one CSV row per included title; include Provider when exporting all services.
  const csv = toCsv(items, !providerId);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
  res.send("\uFEFF" + csv); // BOM so Excel reads UTF-8 correctly
});

// Manually remove a title (hidden from future syncs until restored).
libraryRouter.delete("/:providerId/:itemId", (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  const result = deleteLibraryItem(provider.id, req.params.itemId);
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.json({ ok: true, count: result.snapshot.count });
});

// Allow a manually hidden title to return on the next sync.
libraryRouter.post("/:providerId/:itemId/restore", (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  const result = restoreLibraryItem(provider.id, req.params.itemId);
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.json({ ok: true });
});
