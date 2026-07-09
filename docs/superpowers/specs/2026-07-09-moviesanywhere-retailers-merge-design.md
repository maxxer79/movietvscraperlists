# Movies Anywhere + Retailers + Merged Library Design

**Date:** 2026-07-09  
**Status:** Approved for implementation planning  
**Approach:** Per-provider scrapers + server-side merge (Approach 1)

## Goal

Extend MovieTVScraperLists so the user can connect Movies Anywhere and major linked retailers as separate accounts, see **one library card per title** (not duplicate posters), know **which retailers still have the title**, and be notified when a retailer removes it from their account — without changing the working Fandango scraper and without mixing movies and TV across sources.

## Non-goals

- Changing Fandango login, API client, scrape job fast-path, or storage format.
- Deduplicating or rewriting historical Fandango library JSON on disk.
- Scraping subscription browse catalogs (Prime included titles, etc.) — only owned/purchased libraries.
- Implementing Sony Pictures Core or Universal Pictures (they are removed).
- Using Movies Anywhere “available on” flags as the source of truth for Apple / Google / Prime presence.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Provider cards | Separate Connect/Sync per service (design A) |
| Movies Anywhere in UI | Own Connect/Sync card (not hub-only) |
| Title matching | Prefer official IDs (IMDb → TMDB → MA id), fallback normalized title + year + type |
| Scope of this effort | Full pass: MA + Apple TV + Google Play/YouTube + Prime scrapers, registry cleanup, merge + removal UX |
| Architecture | Keep per-provider libraries; merge at read time |
| Fandango | Untouched |
| Movie/TV | New providers movies-only; merge never crosses type |

## Providers

### Keep

- `fandango` — Fandango at Home (existing implementation, no behavioral changes)

### Remove from registry and defaults

- `sony` — Sony Pictures Core
- `universal` — Universal Pictures

### Add (implemented providers)

| ID | Name | Login / library intent |
|----|------|------------------------|
| `moviesanywhere` | Movies Anywhere | MA account; scrape `my-movies` (or MA library API). Always `type: "movie"`. |
| `appletv` | Apple TV | Apple ID; purchased movie library. |
| `googleplay` | Google Play / YouTube | Google account; purchased movie library. |
| `primevideo` | Prime Video | Amazon account; purchased/owned movie library only (not Prime subscription catalog). |

### Default `ENABLED_PROVIDERS`

```
fandango,moviesanywhere,appletv,googleplay,primevideo
```

Update `.env.example`, `docker-compose.yml`, and Portainer docs accordingly.

## Movie / TV boundary

- Fandango continues separate movies and TV passes (unchanged).
- Movies Anywhere, Apple TV, Google Play/YouTube, and Prime Video scrape **movies only**.
- Every item from new providers is stored with `type: "movie"`.
- Merge key includes `type`, so a movie never merges with a TV title.
- No TV scrape paths for the new providers in this design (can be revisited later as a separate change).

## Storage model

Unchanged shape per provider:

- `data/library/{providerId}.json` — active items, `removed[]`, `hiddenIds[]`
- `data/sessions/{providerId}.session.enc` — encrypted Playwright `storageState`
- Sync continues to use `saveLibraryFromSync`: detect missing ids → `removed` with `reason: "sync"`; titles that return leave `removed`.

Fandango files and sync logic remain isolated. No migration of existing Fandango snapshots is required for merge (merge is computed at read time).

## Merge layer

### Where

Server-side when serving the combined library (e.g. `GET /api/library` and export paths that should show the user-facing library). Per-provider raw snapshots remain on disk for sync/removal accuracy.

### Match key priority

For each `MediaItem`, derive the strongest available key:

1. IMDb id (from `meta` or future dedicated field)
2. TMDB id
3. Movies Anywhere id
4. Fallback: `normalize(title) + year + type`  
   - `normalize`: lowercase, strip punctuation/extra whitespace, collapse common articles only if needed for consistency  
   - If year is missing, fallback key is weaker; prefer not to merge two year-less titles unless an official id matches

Never merge across different `type` values.

### Merged title shape (API)

One card per match group:

- `id` — stable merge id (prefer strongest external id; else hash of fallback key)
- `title`, `year`, `type`, `posterUrl` — single values (poster: first non-empty; prefer higher-quality URL when detectable)
- `retailers` — array of active sources, each with at least:
  - `provider` / `providerName`
  - optional `quality`, `url`, provider-local `id`
- Search/filter fields remain usable (title, type, retailer membership)

### Filtering

- Type filter: Movies / TV / both (TV remains Fandango-driven for now)
- Retailer filter: titles that **currently** list that retailer in `retailers`
- Provider filter semantics update from “row tagged with provider” to “merged title currently available on provider”

## Removal behavior

When provider P syncs and title T is missing from P’s scrape but was present last sync:

1. T is removed from P’s active `items` and recorded in P’s `removed` (`reason: "sync"`, `removedAt`, `lastSeenAt`) — existing mechanism.
2. Merged view drops P from that title’s `retailers` badges.
3. If no retailers remain active for T, T leaves the main library list and appears in the Removed view.
4. Removed view should still surface **per-retailer loss events** so the user can see which retailer removed the title even when other retailers still have it (badge count drops on the main card; Removed lists the loss).

When a later sync of P sees T again:

- T returns to P’s active items; P’s removed entry for that id is cleared (existing restore-on-return).
- Merged card shows P’s badge again.

Manual hide/delete remains per-provider `hiddenIds` so a bad/misclassified card does not reappear from that source until restored.

## Scraping & login

### Shared contract

Each new service implements the existing `Provider` interface:

- `startLogin` / `submitInput` / `isLoggedIn` / `scrapeLibrary`
- Interactive Playwright login with 2FA via existing `need_input` flow
- Encrypted session per provider id
- Background scrape jobs; on session expiry throw `SessionExpiredError` for that provider only

### Movies Anywhere

- Login URL: Movies Anywhere login (not Fandango). Linked Fandango/retailer accounts are MA-side settings.
- Prefer reverse-engineered library API if discovered during implementation; else DOM scrape of movies library with scroll/pagination.
- Force `type: "movie"`; skip TV-like rows if any appear.
- Capture IMDb / TMDB / MA ids into `meta` when available (feeds merge).
- If MA exposes “available on” retailer hints, store in `meta` as informational only — **do not** treat as proof the user still owns the title on Apple / Google / Prime.

### Apple TV, Google Play / YouTube, Prime Video

- Separate login and library URLs per service.
- Prefer API/network capture when available; DOM fallback otherwise.
- Owned/purchased movies only (exclude wishlist/rentals/subscription catalog where distinguishable).
- Persist stable external ids when found.
- Expect Apple ID / Google / Amazon 2FA; reuse existing code-prompt login steps.
- Debug dumps via existing helpers (`data/debug/`) for selector tuning.

### Fandango

No changes to `fandango.ts`, `vuduApi.ts`, Fandango-specific auth capture, or Fandango scrape fast-path.

### Scrape safety

- Only replace a provider library snapshot after a successful full scrape for that run.
- Failed/partial scrapes must not wipe the previous good library.
- Session expiry prompts reconnect for that provider only.

## UI

### Provider cards

Show Connect/Sync/Disconnect for: Fandango, Movies Anywhere, Apple TV, Google Play / YouTube, Prime Video.  
Do not show Sony or Universal.

### Library cards

- One poster and one title per merged movie.
- Retailer badges for **active** sources only (optional quality on badge).
- No duplicate cards for the same matched title across providers.

### Removed tab

- List removal events with retailer name, when first missing, and reason (`sync` vs `manual`).
- Support the case where the title remains in the main library on other retailers (retailer loss) and the case where it is fully gone.

### Export

Default CSV/JSON export uses the **merged** view: one row per title, with a retailers column (and optional per-retailer quality). Raw per-provider export is optional/out of scope unless needed for debugging.

## Error handling

| Case | Behavior |
|------|----------|
| Session expired on one provider | That provider shows reconnect; others unaffected |
| Scrape fails mid-run | Keep previous snapshot; surface job error |
| Weak metadata (no id, no year) | Do not aggressively merge; prefer separate cards over false merges |
| Provider not yet reliably scrapable | Prefer shipping working scrape; if blocked by anti-bot, document blocker — goal remains full implementation for all four new providers |

## Testing

### Automated

- Unit tests for merge key priority (IMDb beats title+year; type mismatch never merges).
- Unit tests for removal → retailer badge drop; last retailer gone → title leaves main library.
- Unit tests for restore-on-return restoring a badge.

### Manual / regression

- Fandango connect/sync still returns movies and TV correctly (unchanged).
- Movies Anywhere sync returns movies only (no TV bleed).
- Same title on Fandango + MA → one card, two badges.
- Sync that drops a title on one provider → badge removed, removal recorded; other retailers unchanged.
- Connect flows for Apple / Google / Prime with 2FA when required.

## Implementation sketch (for planning)

1. Registry + env cleanup: remove Sony/Universal; register new provider ids (stubs first if needed, then real classes).
2. Merge service + library API/export response shape + web `MediaCard` retailer badges.
3. Implement `MoviesAnywhereProvider` (login + movies scrape + ids in `meta`).
4. Implement `AppleTvProvider`, `GooglePlayProvider`, `PrimeVideoProvider`.
5. Docs/README status table and Portainer/`ENABLED_PROVIDERS` updates.
6. Tests for merge and removal badge behavior; manual verification checklist above.

## Open risks

- Apple / Google / Amazon login and library pages may be hostile to automation; may need iterative selector/API discovery with live accounts.
- Movies Anywhere may not expose IMDb/TMDB on every row; title+year fallback must be conservative.
- Duplicate titles with the same name/year (remakes) can false-merge without external ids — accept rare errors; prefer ids whenever present.
