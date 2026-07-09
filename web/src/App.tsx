import { useCallback, useEffect, useMemo, useState } from "react";
import { api, clearToken } from "./api";
import type { CombinedItem, ProviderStatus, RemovedItem, SyncProgress } from "./types";
import { VersionBadge } from "./components/VersionBadge";
import { ProviderCard } from "./components/ProviderCard";
import { LoginModal } from "./components/LoginModal";
import { MediaCard } from "./components/MediaCard";
import { PasswordGate } from "./components/PasswordGate";
import { AzNav, titleLetter } from "./components/AzNav";
import { RemovedPanel } from "./components/RemovedPanel";

export function App() {
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

  const [dark, setDark] = useState(
    () => localStorage.getItem("mtv_theme") !== "light"
  );
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [items, setItems] = useState<CombinedItem[]>([]);
  const [removed, setRemoved] = useState<RemovedItem[]>([]);
  const [libraryTab, setLibraryTab] = useState<"library" | "removed">("library");
  const [loginProvider, setLoginProvider] = useState<ProviderStatus | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<Record<string, SyncProgress>>({});
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);

  const [search, setSearch] = useState("");
  const [filterProvider, setFilterProvider] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterQuality, setFilterQuality] = useState("all");
  const [sort, setSort] = useState("title");

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const [p, lib] = await Promise.all([api.providers(), api.library()]);
    setProviders(p);
    setItems(lib.items);
    setRemoved(lib.removed ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { required } = await api.authStatus();
        setAuthRequired(required);
        if (required) {
          try {
            await api.providers();
          } catch {
            setLocked(true);
            setReady(true);
            return;
          }
        }
        await refresh();
      } catch {
        /* ignore */
      } finally {
        setReady(true);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("mtv_theme", dark ? "dark" : "light");
  }, [dark]);

  async function scrape(id: string, name: string) {
    setBusyId(id);
    setSyncProgress((s) => ({
      ...s,
      [id]: {
        message: "Starting sync…",
        logLines: [],
        showLog: s[id]?.showLog ?? false,
      },
    }));
    try {
      const start = await api.scrape(id);
      if (!start.jobId) {
        throw new Error("Server did not return a sync job — rebuild and redeploy the app");
      }
      toast(`${name}: syncing library — this may take a few minutes…`);

      // Large libraries + credential capture can take a while; keep polling for 45 min.
      const deadline = Date.now() + 45 * 60 * 1000;
      while (Date.now() < deadline) {
        let status;
        try {
          status = await api.scrapeStatus(id, start.jobId);
        } catch (e) {
          if ((e as Error).message === "Failed to fetch") {
            setSyncProgress((s) => ({
              ...s,
              [id]: {
                ...s[id],
                message: "Connection interrupted — retrying…",
                logLines: s[id]?.logLines ?? [],
                showLog: s[id]?.showLog ?? false,
              },
            }));
            toast(`${name}: connection interrupted — retrying…`);
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }

        setSyncProgress((s) => ({
          ...s,
          [id]: {
            message: status.message,
            itemsFound: status.itemsFound,
            logLines: status.logLines ?? s[id]?.logLines ?? [],
            startedAt: status.startedAt ?? s[id]?.startedAt,
            showLog: s[id]?.showLog ?? false,
          },
        }));

        if (status.status === "running") {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (status.status === "done") {
          toast(`${name}: synced ${status.count ?? status.snapshot?.count ?? 0} titles`);
          await refresh();
          return;
        }

        if (status.sessionExpired) {
          toast(`${name}: session expired — please reconnect`);
          await refresh();
          return;
        }
        throw new Error(status.error || status.message || "Sync failed");
      }
      throw new Error("Sync timed out after 45 minutes — check the sync log and try again");
    } catch (e) {
      const err = e as Error & { body?: { sessionExpired?: boolean } };
      if (err.body?.sessionExpired) {
        toast(`${name}: session expired — please reconnect`);
        await refresh();
      } else {
        toast(`${name}: ${err.message}`);
      }
    } finally {
      setBusyId(null);
      setSyncProgress((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    }
  }

  function toggleSyncLog(id: string) {
    setSyncProgress((s) => ({
      ...s,
      [id]: {
        ...s[id],
        message: s[id]?.message ?? "Syncing…",
        logLines: s[id]?.logLines ?? [],
        showLog: !s[id]?.showLog,
      },
    }));
  }

  async function disconnect(id: string, name: string) {
    setBusyId(id);
    try {
      await api.disconnect(id);
      toast(`${name} disconnected`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    let list = items;
    if (filterProvider !== "all")
      list = list.filter((i) =>
        (i.retailers ?? []).some((r) => r.provider === filterProvider)
      );
    if (filterType !== "all") list = list.filter((i) => i.type === filterType);
    if (filterQuality !== "all")
      list = list.filter((i) =>
        filterQuality === "4k"
          ? i.quality?.includes("4K")
          : i.quality?.toUpperCase().includes(filterQuality.toUpperCase())
      );
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((i) => i.title.toLowerCase().includes(q));
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === "year") return (b.year || 0) - (a.year || 0);
      if (sort === "provider") {
        const names = (i: CombinedItem) =>
          (i.retailers ?? []).map((r) => r.providerName).join(", ");
        return names(a).localeCompare(names(b));
      }
      return a.title.localeCompare(b.title);
    });
    return sorted;
  }, [items, filterProvider, filterType, filterQuality, search, sort]);

  const azLetters = useMemo(() => {
    const set = new Set<string>();
    for (const item of filtered) set.add(titleLetter(item.title));
    return set;
  }, [filtered]);

  function jumpToLetter(letter: string) {
    const el = document.querySelector(`[data-letter="${letter}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteItem(item: CombinedItem) {
    if (
      !confirm(
        `Remove “${item.title}” from all retailers currently listed on this card?\n\nIt will stay hidden on future Syncs until you undo it from Removed.`
      )
    ) {
      return;
    }
    try {
      const result = await api.deleteMergedItem(item.id);
      if (result.failed && result.failed.length > 0) {
        const n = Array.isArray(result.failed) ? result.failed.length : 0;
        toast(
          result.ok === false && (!result.deleted || (result.deleted as unknown[]).length === 0)
            ? `Could not remove “${item.title}”`
            : `Removed “${item.title}” from some retailers; ${n} failed — refresh to see what's left`
        );
        await refresh();
        return;
      }
      toast(`Removed “${item.title}”`);
      await refresh();
      setLibraryTab("removed");
    } catch (err) {
      toast((err as Error).message || "Could not remove title");
    }
  }

  async function restoreItem(item: RemovedItem) {
    try {
      await api.restoreItem(item.provider, item.id);
      toast(`“${item.title}” can return on the next Sync`);
      await refresh();
    } catch (err) {
      toast((err as Error).message || "Could not restore title");
    }
  }

  function download(format: "csv" | "json") {
    const provider = filterProvider !== "all" ? filterProvider : undefined;
    window.open(api.exportUrl(format, provider), "_blank");
  }

  if (!ready) {
    return (
      <div className="center-screen">
        <span className="spinner" />
      </div>
    );
  }

  if (locked) {
    return (
      <PasswordGate
        onUnlock={async () => {
          setLocked(false);
          await refresh();
        }}
      />
    );
  }

  const connectedProviders = providers.filter((p) => p.itemCount > 0);
  const filterableProviders = providers.length > 0 ? providers : connectedProviders;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-logo">🎞️</div>
          <div>
            <h1>My Movie &amp; TV Library</h1>
            <p>Everything you own, in one place</p>
          </div>
        </div>
        <div className="header-actions">
          <VersionBadge />
          <button
            className="btn icon-btn"
            title="Toggle light / dark"
            onClick={() => setDark((d) => !d)}
          >
            {dark ? "☀️" : "🌙"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Refresh"
            onClick={() => refresh()}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      <section className="provider-grid">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            busy={busyId === p.id}
            syncProgress={syncProgress[p.id]}
            onConnect={() => setLoginProvider(p)}
            onScrape={() => scrape(p.id, p.name)}
            onDisconnect={() => disconnect(p.id, p.name)}
            onToggleLog={() => toggleSyncLog(p.id)}
          />
        ))}
      </section>

      <div className="panel toolbar">
        <div className="search">
          <input
            placeholder="Search titles…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="select"
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
        >
          <option value="all">All services</option>
          {filterableProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="all">Movies &amp; TV</option>
          <option value="movie">Movies only</option>
          <option value="tv">TV only</option>
        </select>
        <select
          className="select"
          value={filterQuality}
          onChange={(e) => setFilterQuality(e.target.value)}
        >
          <option value="all">Any quality</option>
          <option value="4k">4K UHD</option>
          <option value="hd">HD</option>
          <option value="sd">SD</option>
        </select>
        <select
          className="select"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="title">Sort: Title</option>
          <option value="year">Sort: Year</option>
          <option value="provider">Sort: Service</option>
        </select>
        <button className="btn btn-sm" onClick={() => download("csv")}>
          ⬇ CSV
        </button>
        <button className="btn btn-sm" onClick={() => download("json")}>
          ⬇ JSON
        </button>
      </div>

      <p className="count-line">
        Showing {filtered.length} of {items.length} titles ·{" "}
        {items.filter((i) => i.type === "movie").length} movies ·{" "}
        {items.filter((i) => i.type === "tv").length} TV
        {removed.length > 0 ? ` · ${removed.length} removed` : ""}
      </p>

      <div className="library-tabs">
        <button
          type="button"
          className={`library-tab ${libraryTab === "library" ? "library-tab-active" : ""}`}
          onClick={() => setLibraryTab("library")}
        >
          Library
        </button>
        <button
          type="button"
          className={`library-tab ${libraryTab === "removed" ? "library-tab-active" : ""}`}
          onClick={() => setLibraryTab("removed")}
        >
          Removed{removed.length > 0 ? ` (${removed.length})` : ""}
        </button>
      </div>

      {libraryTab === "removed" ? (
        <RemovedPanel items={removed} onRestore={restoreItem} />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="big">🍿</div>
          <p>
            {items.length === 0
              ? "No titles yet. Connect a service above, then hit “Sync library”."
              : "No titles match your filters."}
          </p>
        </div>
      ) : (
        <div className="library-layout">
          <div className="library-grid">
            {filtered.map((item, index) => {
              const letter = titleLetter(item.title);
              const prevLetter =
                index > 0 ? titleLetter(filtered[index - 1].title) : null;
              const isFirstOfLetter = letter !== prevLetter;
              return (
                <div
                  key={`${item.provider}:${item.id}`}
                  data-letter={isFirstOfLetter ? letter : undefined}
                  className="library-grid-item"
                >
                  <MediaCard
                    item={item}
                    showProvider={filterProvider === "all"}
                    onDelete={deleteItem}
                  />
                </div>
              );
            })}
          </div>
          <AzNav available={azLetters} onJump={jumpToLetter} />
        </div>
      )}

      {loginProvider ? (
        <LoginModal
          provider={loginProvider}
          onClose={() => setLoginProvider(null)}
          onConnected={async () => {
            setLoginProvider(null);
            toast(`${loginProvider.name} connected`);
            await refresh();
          }}
        />
      ) : null}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>

      {authRequired ? (
        <div style={{ textAlign: "center", marginTop: 40 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearToken();
              location.reload();
            }}
          >
            Sign out of app
          </button>
        </div>
      ) : null}
    </div>
  );
}
