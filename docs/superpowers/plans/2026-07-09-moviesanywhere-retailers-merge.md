# Movies Anywhere + Retailers + Merged Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Movies Anywhere, Apple TV, Google Play/YouTube, and Prime Video as separate Connect/Sync providers; remove Sony/Universal; merge titles into one card with retailer badges and per-retailer removal tracking — without changing Fandango.

**Architecture:** Keep per-provider `data/library/{id}.json` and sync/removal logic. Add a pure merge service used by `GET /api/library` and export. New providers implement the existing `Provider` interface (Playwright login + movies-only scrape). UI shows one poster per merged title with active retailer chips.

**Tech Stack:** TypeScript, Express, Playwright, React/Vite, Node `node:test` + `tsx` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-09-moviesanywhere-retailers-merge-design.md`

---

## File structure

| File | Responsibility |
|------|----------------|
| `server/src/services/libraryMerge.ts` | Pure merge: match keys, group titles, build `MergedItem` + filter helpers |
| `server/src/services/libraryMerge.test.ts` | Unit tests for merge + removal badge behavior |
| `server/src/routes/library.ts` | Serve merged items; keep removed as per-provider events; delete/restore via retailer ids |
| `server/src/services/exporter.ts` | CSV/JSON for merged rows (`Retailers` column) |
| `server/src/scrapers/registry.ts` | Drop sony/universal; register MA + appletv + googleplay + primevideo |
| `server/src/scrapers/moviesanywhere.ts` | MA login + movies scrape |
| `server/src/scrapers/appletv.ts` | Apple TV login + purchased movies scrape |
| `server/src/scrapers/googleplay.ts` | Google Play/YouTube login + purchased movies scrape |
| `server/src/scrapers/primevideo.ts` | Prime Video login + purchased/owned movies scrape |
| `server/package.json` | Add `test` script |
| `web/src/types.ts` | `RetailerPresence`, `MergedItem` (replace flat `CombinedItem` for library) |
| `web/src/components/MediaCard.tsx` | Retailer badges; delete targets all active retailers or first |
| `web/src/App.tsx` | Filter by retailer membership; sort without single `providerName` |
| `.env.example`, `docker-compose.yml`, `docs/PORTAINER-SETUP.md`, `README.md`, root `package.json` | Provider list docs/defaults |

**Do not modify:** `server/src/scrapers/fandango.ts`, `server/src/scrapers/vuduApi.ts`, Fandango branches in `loginController.ts` / `scrapeJobs.ts`.

---

### Task 1: Add test runner + merge module failing tests

**Files:**
- Modify: `server/package.json`
- Create: `server/src/services/libraryMerge.ts` (minimal exports so tests compile)
- Create: `server/src/services/libraryMerge.test.ts`

- [ ] **Step 1: Add test script to server package**

In `server/package.json`, add dependency-free test script using Node's built-in test runner:

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/index.js",
  "test": "tsx --test src/**/*.test.ts",
  "postinstall": "playwright install chromium"
}
```

- [ ] **Step 2: Write failing merge tests**

Create `server/src/services/libraryMerge.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLibraries,
  type ProviderLibraryInput,
} from "./libraryMerge.js";
import type { MediaItem } from "../scrapers/types.js";

function movie(partial: Partial<MediaItem> & { id: string; title: string }): MediaItem {
  return { type: "movie", ...partial };
}

describe("mergeLibraries", () => {
  it("merges same IMDb id across providers into one card with two retailers", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({
            id: "f1",
            title: "Inception",
            year: 2010,
            posterUrl: "https://example.com/a.jpg",
            quality: "4K UHD",
            meta: { imdbId: "tt1375666" },
          }),
        ],
      },
      {
        providerId: "moviesanywhere",
        providerName: "Movies Anywhere",
        items: [
          movie({
            id: "ma1",
            title: "Inception",
            year: 2010,
            meta: { imdbId: "tt1375666" },
          }),
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "Inception");
    assert.deepEqual(
      merged[0].retailers.map((r) => r.provider).sort(),
      ["fandango", "moviesanywhere"]
    );
    assert.equal(merged[0].posterUrl, "https://example.com/a.jpg");
  });

  it("does not merge movie with tv even if titles match", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({ id: "m1", title: "The Office", year: 2005 }),
          { id: "t1", title: "The Office", type: "tv", year: 2005 },
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 2);
  });

  it("prefers IMDb over title+year when both present", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({
            id: "a",
            title: "Wrong Title",
            year: 1999,
            meta: { imdbId: "tt0111161" },
          }),
        ],
      },
      {
        providerId: "appletv",
        providerName: "Apple TV",
        items: [
          movie({
            id: "b",
            title: "The Shawshank Redemption",
            year: 1994,
            meta: { imdbId: "tt0111161" },
          }),
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].retailers.length, 2);
  });

  it("falls back to normalized title+year+type when no external ids", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [movie({ id: "1", title: "Dune", year: 2021, quality: "HDX" })],
      },
      {
        providerId: "primevideo",
        providerName: "Prime Video",
        items: [movie({ id: "2", title: "dune", year: 2021 })],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].retailers.length, 2);
  });

  it("does not merge year-less titles on title-only fallback", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [movie({ id: "1", title: "Heat" })],
      },
      {
        providerId: "appletv",
        providerName: "Apple TV",
        items: [movie({ id: "2", title: "Heat" })],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 2);
  });
});
```

- [ ] **Step 3: Add minimal stub exports so the test file loads**

Create `server/src/services/libraryMerge.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests — expect FAIL**

Run: `npm test --workspace server`

Expected: FAIL with `not implemented` (or assertion failures if throw is caught differently).

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/src/services/libraryMerge.ts server/src/services/libraryMerge.test.ts
git commit -m "test: add failing library merge tests"
```

---

### Task 2: Implement library merge

**Files:**
- Modify: `server/src/services/libraryMerge.ts`
- Test: `server/src/services/libraryMerge.test.ts`

- [ ] **Step 1: Implement mergeLibraries**

Replace `libraryMerge.ts` body with:

```typescript
import { createHash } from "node:crypto";
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
  provider: string;
  providerName: string;
}

export interface ProviderLibraryInput {
  providerId: string;
  providerName: string;
  items: MediaItem[];
}

function metaString(meta: MediaItem["meta"], key: string): string | undefined {
  const v = meta?.[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/** Normalize title for fallback matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Strongest match key. Returns null when only a weak title-only key would
 * be available (no external id and no year) — caller uses unique per-item key.
 */
export function matchKey(item: MediaItem): { key: string; strength: "id" | "titleYear" | "unique" } {
  const imdb = metaString(item.meta, "imdbId") ?? metaString(item.meta, "imdb");
  if (imdb) return { key: `imdb:${imdb.toLowerCase()}`, strength: "id" };

  const tmdb = metaString(item.meta, "tmdbId") ?? metaString(item.meta, "tmdb");
  if (tmdb) return { key: `tmdb:${item.type}:${tmdb}`, strength: "id" };

  const ma = metaString(item.meta, "moviesAnywhereId") ?? metaString(item.meta, "maId");
  if (ma) return { key: `ma:${ma}`, strength: "id" };

  if (item.year) {
    return {
      key: `ty:${item.type}:${normalizeTitle(item.title)}:${item.year}`,
      strength: "titleYear",
    };
  }

  return {
    key: `unique:${item.type}:${normalizeTitle(item.title)}:${item.id}`,
    strength: "unique",
  };
}

function pickPoster(current?: string, next?: string): string | undefined {
  if (!current) return next;
  if (!next) return current;
  // Prefer larger-looking URLs / non-thumbnail paths when obvious.
  const score = (u: string) => {
    let s = 0;
    if (/(\d{3,4})x(\d{3,4})/.test(u)) s += 2;
    if (!/thumb|small|tiny/i.test(u)) s += 1;
    return s;
  };
  return score(next) > score(current) ? next : current;
}

export function mergeLibraries(inputs: ProviderLibraryInput[]): MergedItem[] {
  const groups = new Map<
    string,
    {
      title: string;
      type: MediaItem["type"];
      year?: number;
      quality?: string;
      posterUrl?: string;
      url?: string;
      meta?: MediaItem["meta"];
      retailers: RetailerPresence[];
    }
  >();

  for (const input of inputs) {
    for (const item of input.items) {
      const { key } = matchKey(item);
      const existing = groups.get(key);
      const presence: RetailerPresence = {
        provider: input.providerId,
        providerName: input.providerName,
        itemId: item.id,
        quality: item.quality,
        url: item.url,
      };

      if (!existing) {
        groups.set(key, {
          title: item.title,
          type: item.type,
          year: item.year,
          quality: item.quality,
          posterUrl: item.posterUrl,
          url: item.url,
          meta: item.meta,
          retailers: [presence],
        });
        continue;
      }

      // Prefer a more complete display title (longer non-empty) when IMDb-merged.
      if (item.title && item.title.length > existing.title.length) {
        existing.title = item.title;
      }
      if (item.year && !existing.year) existing.year = item.year;
      existing.posterUrl = pickPoster(existing.posterUrl, item.posterUrl);
      if (!existing.url && item.url) existing.url = item.url;
      if (item.quality && (!existing.quality || item.quality.includes("4K"))) {
        existing.quality = item.quality;
      }
      if (item.meta) {
        existing.meta = { ...(existing.meta ?? {}), ...item.meta };
      }
      if (!existing.retailers.some((r) => r.provider === presence.provider && r.itemId === presence.itemId)) {
        existing.retailers.push(presence);
      }
    }
  }

  const out: MergedItem[] = [];
  for (const [key, g] of groups) {
    const retailers = [...g.retailers].sort((a, b) => a.providerName.localeCompare(b.providerName));
    const first = retailers[0];
    const idHash = createHash("sha1").update(key).digest("hex").slice(0, 16);
    out.push({
      id: idHash,
      title: g.title,
      type: g.type,
      year: g.year,
      quality: g.quality,
      posterUrl: g.posterUrl,
      url: g.url,
      meta: g.meta,
      retailers,
      provider: first.provider,
      providerName: first.providerName,
    });
  }

  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** True if merged title currently lists the given provider id. */
export function hasRetailer(item: MergedItem, providerId: string): boolean {
  return item.retailers.some((r) => r.provider === providerId);
}
```

- [ ] **Step 2: Run tests — expect PASS**

Run: `npm test --workspace server`

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/libraryMerge.ts server/src/services/libraryMerge.test.ts
git commit -m "feat: merge libraries by IMDb/TMDB/MA id or title+year"
```

---

### Task 3: Wire merge into library API + export

**Files:**
- Modify: `server/src/routes/library.ts`
- Modify: `server/src/services/exporter.ts`
- Modify: `server/src/services/exporter.test.ts` (create)

- [ ] **Step 1: Write failing export test for Retailers column**

Create `server/src/services/exporter.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toMergedCsv } from "./exporter.js";

describe("toMergedCsv", () => {
  it("includes Retailers column", () => {
    const csv = toMergedCsv([
      {
        id: "x",
        title: "Dune",
        type: "movie",
        year: 2021,
        quality: "4K UHD",
        retailers: [
          { provider: "fandango", providerName: "Fandango at Home", itemId: "1" },
          { provider: "moviesanywhere", providerName: "Movies Anywhere", itemId: "2" },
        ],
        provider: "fandango",
        providerName: "Fandango at Home",
      },
    ]);
    assert.match(csv, /Retailers/);
    assert.match(csv, /Fandango at Home; Movies Anywhere/);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (toMergedCsv missing)**

Run: `npm test --workspace server -- src/services/exporter.test.ts`

Expected: FAIL module/export not found.

- [ ] **Step 3: Add toMergedCsv and update library route**

Append to `server/src/services/exporter.ts`:

```typescript
import type { MergedItem } from "./libraryMerge.js";

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
```

Replace `collectAll` usage in `library.ts` GET `/` and default export path:

```typescript
import { mergeLibraries, type MergedItem } from "../services/libraryMerge.js";
import { toCsv, toMergedCsv } from "../services/exporter.js";

function collectMerged(): MergedItem[] {
  const inputs = enabledProviders().map((p) => ({
    providerId: p.id,
    providerName: p.name,
    items: loadLibrary(p.id)?.items ?? [],
  }));
  return mergeLibraries(inputs);
}

libraryRouter.get("/", (_req, res) => {
  const items = collectMerged();
  const removed = collectRemoved();
  res.json({ count: items.length, items, removedCount: removed.length, removed });
});
```

For export without `provider` query: use `collectMerged()` + `toMergedCsv`.  
For export with `provider=…`: keep raw per-provider rows via existing `toCsv` (debug/raw path).

Delete endpoint: when UI deletes a merged card, it should delete each active retailer presence. Add:

```typescript
libraryRouter.delete("/merged/:mergedId", (req, res) => {
  const items = collectMerged();
  const item = items.find((i) => i.id === req.params.mergedId);
  if (!item) return res.status(404).json({ error: "Not found" });
  for (const r of item.retailers) {
    deleteLibraryItem(r.provider, r.itemId);
  }
  res.json({ ok: true });
});
```

Keep existing `DELETE /:providerId/:itemId` for single-retailer deletes from Removed flows.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test --workspace server`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/library.ts server/src/services/exporter.ts server/src/services/exporter.test.ts
git commit -m "feat: serve merged library API and CSV retailers column"
```

---

### Task 4: Registry cleanup + new provider stubs (then real classes in later tasks)

**Files:**
- Modify: `server/src/scrapers/registry.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `docs/PORTAINER-SETUP.md`
- Modify: `package.json` (root description)
- Modify: `README.md` (status table)

- [ ] **Step 1: Update registry**

Replace `all` in `registry.ts` with:

```typescript
import { FandangoProvider } from "./fandango.js";
import { StubProvider } from "./stubProvider.js";
import type { Provider } from "./types.js";

const all: Provider[] = [
  new FandangoProvider(),
  new StubProvider(
    "moviesanywhere",
    "Movies Anywhere",
    "https://moviesanywhere.com/login",
    "https://moviesanywhere.com/my-movies",
    "Movies only. Linked retailers (Fandango, Apple, etc.) are configured on your Movies Anywhere account."
  ),
  new StubProvider(
    "appletv",
    "Apple TV",
    "https://tv.apple.com/login",
    "https://tv.apple.com/shop/movies",
    "Purchased movies library. Apple ID login; 2FA supported."
  ),
  new StubProvider(
    "googleplay",
    "Google Play / YouTube",
    "https://play.google.com/store/movies",
    "https://play.google.com/store/movies?category=OWNED",
    "Purchased movies on Google Play / YouTube."
  ),
  new StubProvider(
    "primevideo",
    "Prime Video",
    "https://www.amazon.com/ap/signin",
    "https://www.primevideo.com/",
    "Purchased/owned movies only — not Prime subscription catalog."
  ),
];
```

(Real provider classes replace these stubs in Tasks 6–9.)

- [ ] **Step 2: Update env defaults**

`.env.example`:

```
# Available: fandango,moviesanywhere,appletv,googleplay,primevideo
ENABLED_PROVIDERS=fandango,moviesanywhere,appletv,googleplay,primevideo
```

Same string in `docker-compose.yml` and `docs/PORTAINER-SETUP.md`.

Root `package.json` description: mention Fandango, Movies Anywhere, Apple TV, Google Play/YouTube, Prime Video (drop Sony/Universal).

README status table:

| Service | Status |
| Fandango at Home | Implemented |
| Movies Anywhere | Coming next (Task 6) |
| Apple TV | Coming next |
| Google Play / YouTube | Coming next |
| Prime Video | Coming next |

- [ ] **Step 3: Commit**

```bash
git add server/src/scrapers/registry.ts .env.example docker-compose.yml docs/PORTAINER-SETUP.md package.json README.md
git commit -m "chore: drop Sony/Universal; register MA Apple Google Prime providers"
```

---

### Task 5: Frontend merged cards + retailer filter

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/MediaCard.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts` (if delete path changes)

- [ ] **Step 1: Update types**

Replace `CombinedItem` in `web/src/types.ts` with:

```typescript
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

/** @deprecated alias while migrating — same as MergedItem */
export type CombinedItem = MergedItem;
```

- [ ] **Step 2: Update MediaCard badges**

In `MediaCard.tsx`, replace single provider chip with:

```tsx
{showProvider
  ? item.retailers.map((r) => (
      <span key={`${r.provider}:${r.itemId}`} className="chip chip-provider" title={r.quality}>
        {r.providerName}
        {r.quality ? ` · ${r.quality}` : ""}
      </span>
    ))
  : null}
```

- [ ] **Step 3: Update App filters and delete**

In `App.tsx` filtered list:

```typescript
if (filterProvider !== "all") {
  list = list.filter((i) => i.retailers.some((r) => r.provider === filterProvider));
}
```

Sort by provider: sort by joined retailer names:

```typescript
if (sort === "provider") {
  return iRetailers(a).localeCompare(iRetailers(b));
}
function iRetailers(i: MergedItem) {
  return i.retailers.map((r) => r.providerName).join(", ");
}
```

Delete: call new API `DELETE /api/library/merged/:id` (add to `api.ts`):

```typescript
deleteMergedItem: (mergedId: string) =>
  request(`/api/library/merged/${encodeURIComponent(mergedId)}`, { method: "DELETE" }),
```

Confirm copy: “Remove from all retailers currently listed on this card?”

- [ ] **Step 4: Manual smoke (dev)**

Run: `npm run dev`  
Open UI — with only Fandango data, cards still show; filter by Fandango works; badges render.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/components/MediaCard.tsx web/src/App.tsx web/src/api.ts
git commit -m "feat(web): show retailer badges on merged library cards"
```

---

### Task 6: Movies Anywhere provider (real scrape)

**Files:**
- Create: `server/src/scrapers/moviesanywhere.ts`
- Modify: `server/src/scrapers/registry.ts` (replace StubProvider for MA)

- [ ] **Step 1: Implement MoviesAnywhereProvider**

Model on `fandango.ts` login helpers. Required behavior:

- `id = "moviesanywhere"`, `implemented = true`
- `loginUrl = "https://moviesanywhere.com/login"`
- `libraryUrl = "https://moviesanywhere.com/my-movies"`
- `startLogin`: goto login, dismiss cookies, fill email/password selectors (mark `TUNE:`), submit, detect 2FA via `looksLikeCodePrompt`
- `submitInput`: fill code field, submit
- `isLoggedIn`: URL/library marker or account menu visible (TUNE)
- `scrapeLibrary`:
  - Navigate to my-movies only
  - Prefer intercepting XHR/fetch JSON library responses if present; else DOM card scrape with scroll
  - Every item `type: "movie"`
  - Skip rows that look like TV/season
  - Put `imdbId` / `tmdbId` / `moviesAnywhereId` in `meta` when found in links or JSON
  - `dumpDebug` on first empty scrape

Skeleton structure (fill selectors during live tuning):

```typescript
export class MoviesAnywhereProvider implements Provider {
  readonly id = "moviesanywhere";
  readonly name = "Movies Anywhere";
  readonly implemented = true;
  readonly loginUrl = "https://moviesanywhere.com/login";
  readonly libraryUrl = "https://moviesanywhere.com/my-movies";
  readonly notes =
    "Movies only. Use your Movies Anywhere login (Fandango link is on MA's side).";

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> { /* ... */ }
  async submitInput(page: Page, field: string, value: string): Promise<LoginStep> { /* ... */ }
  async isLoggedIn(page: Page): Promise<boolean> { /* ... */ }
  async scrapeLibrary(context: BrowserContext, onProgress?): Promise<MediaItem[]> { /* ... */ }
}
```

Register: `new MoviesAnywhereProvider()` instead of MA stub.

- [ ] **Step 2: Live verify**

Connect MA in UI → Sync → confirm movies appear, `type` is movie, no TV bleed. Check `data/debug/` if empty.

- [ ] **Step 3: Commit**

```bash
git add server/src/scrapers/moviesanywhere.ts server/src/scrapers/registry.ts
git commit -m "feat: implement Movies Anywhere movies scraper"
```

- [ ] **Step 4: Update README MA row to Implemented**

---

### Task 7: Apple TV provider

**Files:**
- Create: `server/src/scrapers/appletv.ts`
- Modify: `server/src/scrapers/registry.ts`

- [ ] **Step 1: Implement AppleTvProvider**

- Login via Apple ID flow on tv.apple.com (or appleid.apple.com redirect); support 2FA code
- Scrape purchased **movies** library only
- `type: "movie"` always
- Capture external ids into `meta` when available
- Heavy use of `TUNE:` + `dumpDebug` — Apple pages change often

- [ ] **Step 2: Live verify Connect + Sync**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: implement Apple TV purchased movies scraper"
```

---

### Task 8: Google Play / YouTube provider

**Files:**
- Create: `server/src/scrapers/googleplay.ts`
- Modify: `server/src/scrapers/registry.ts`

- [ ] **Step 1: Implement GooglePlayProvider**

- Google account login; handle 2FA / challenge pages via `need_input` when a code field appears
- Library: owned/purchased movies (`category=OWNED` or equivalent library URL discovered live)
- Movies only; store ids in `meta` when present

- [ ] **Step 2: Live verify**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: implement Google Play/YouTube purchased movies scraper"
```

---

### Task 9: Prime Video provider

**Files:**
- Create: `server/src/scrapers/primevideo.ts`
- Modify: `server/src/scrapers/registry.ts`

- [ ] **Step 1: Implement PrimeVideoProvider**

- Amazon sign-in; 2FA/OTP support
- Scrape **purchased/owned** movies only — exclude Prime subscription catalog and rentals when distinguishable (TUNE: prefer “Purchases” / “Your Video Library” style destinations discovered live)
- `type: "movie"`

- [ ] **Step 2: Live verify**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: implement Prime Video purchased movies scraper"
```

---

### Task 10: Docs polish + end-to-end verification

**Files:**
- Modify: `README.md` (all five services status accurate)
- Modify: root `package.json` description if still stale

- [ ] **Step 1: README status table final**

Mark each implemented provider Implemented; note merged one-card library + retailer badges + removal tracking.

- [ ] **Step 2: Regression checklist**

1. Fandango sync still returns movies + TV (unchanged code paths).
2. Same title on Fandango + MA → one card, two badges.
3. Filter by Apple TV shows only titles with that badge.
4. After a sync that drops a title on one provider → badge gone; Removed lists that retailer loss; other badges remain.
5. Export CSV has Retailers column for all-services export.
6. `npm test --workspace server` passes.
7. `npm run build` succeeds.

- [ ] **Step 3: Final commit**

```bash
git add README.md package.json
git commit -m "docs: document merged multi-retailer library"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Remove Sony/Universal | Task 4 |
| Add MA, Apple, Google, Prime providers | Tasks 4, 6–9 |
| Fandango untouched | Explicit non-touch list |
| Movies-only for new providers | Tasks 6–9 |
| Merge by IMDb→TMDB→MA→title+year+type | Tasks 1–2 |
| No year-less title-only merge | Task 1 test + Task 2 |
| One card + retailer badges | Tasks 3, 5 |
| Per-provider removal → badge drop | Existing `saveLibraryFromSync` + merge read path |
| Removed tab per-retailer events | Task 3 keeps `collectRemoved` |
| Merged export Retailers column | Task 3 |
| ENABLED_PROVIDERS / Portainer / README | Tasks 4, 10 |
| Session expiry per provider | Existing scrapeJobs behavior |

## Risks during Tasks 6–9

Live site HTML/API discovery is required. If a provider blocks automation, keep `implemented: true` only when Connect+Sync works for the user’s account; otherwise leave a clear error from `startLogin`/`scrapeLibrary` and document the blocker in the commit message — do not silently ship a stub as implemented.
