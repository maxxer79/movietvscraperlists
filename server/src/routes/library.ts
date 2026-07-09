import { Router } from "express";
import { enabledProviders, getProvider } from "../scrapers/registry.js";
import {
  deleteLibraryItem,
  loadLibrary,
  restoreLibraryItem,
  type RemovedItem,
} from "../services/libraryStore.js";
import { toCsv, toMergedCsv } from "../services/exporter.js";
import { mergeLibraries, type MergedItem } from "../services/libraryMerge.js";
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

function collectMerged(): MergedItem[] {
  const inputs = enabledProviders().map((p) => ({
    providerId: p.id,
    providerName: p.name,
    items: loadLibrary(p.id)?.items ?? [],
  }));
  return mergeLibraries(inputs);
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
  const items = collectMerged();
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

  const stamp = new Date().toISOString().slice(0, 10);

  if (providerId) {
    const provider = getProvider(providerId);
    if (!provider) return res.status(404).json({ error: "Unknown provider" });
    const lib = loadLibrary(provider.id);
    const items: CombinedItem[] = (lib?.items ?? []).map((i) => ({
      ...i,
      provider: provider.id,
      providerName: provider.name,
    }));
    const base = `library-${providerId}-${stamp}`;

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`);
      return res.send(JSON.stringify(items, null, 2));
    }

    const csv = toCsv(items, false);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    return res.send("\uFEFF" + csv);
  }

  const items = collectMerged();
  const base = `library-all-${stamp}`;

  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`);
    return res.send(JSON.stringify(items, null, 2));
  }

  const csv = toMergedCsv(items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
  res.send("\uFEFF" + csv);
});

// Remove a merged title from all retailer libraries it appears in.
libraryRouter.delete("/merged/:mergedId", (req, res) => {
  const merged = collectMerged().find((item) => item.id === req.params.mergedId);
  if (!merged) return res.status(404).json({ error: "Merged item not found" });

  const deleted: Array<{ provider: string; itemId: string }> = [];
  const failed: Array<{ provider: string; itemId: string; error: string }> = [];

  for (const r of merged.retailers) {
    const result = deleteLibraryItem(r.provider, r.itemId);
    if (result.ok) {
      deleted.push({ provider: r.provider, itemId: r.itemId });
    } else {
      failed.push({ provider: r.provider, itemId: r.itemId, error: result.error });
    }
  }

  if (failed.length && deleted.length === 0) {
    return res.status(404).json({ ok: false, deleted, failed });
  }
  if (failed.length) {
    return res.status(207).json({ ok: false, deleted, failed });
  }
  res.json({ ok: true, deleted });
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
