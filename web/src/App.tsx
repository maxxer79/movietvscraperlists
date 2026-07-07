import { useCallback, useEffect, useMemo, useState } from "react";
import { api, clearToken } from "./api";
import type { CombinedItem, ProviderStatus } from "./types";
import { VersionBadge } from "./components/VersionBadge";
import { ProviderCard } from "./components/ProviderCard";
import { LoginModal } from "./components/LoginModal";
import { MediaCard } from "./components/MediaCard";
import { PasswordGate } from "./components/PasswordGate";

export function App() {
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

  const [dark, setDark] = useState(
    () => localStorage.getItem("mtv_theme") !== "light"
  );
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [items, setItems] = useState<CombinedItem[]>([]);
  const [loginProvider, setLoginProvider] = useState<ProviderStatus | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);

  const [search, setSearch] = useState("");
  const [filterProvider, setFilterProvider] = useState("all");
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
    try {
      const res = await api.scrape(id);
      toast(`${name}: synced ${res.snapshot.count} titles`);
      await refresh();
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
    }
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
    if (filterProvider !== "all") list = list.filter((i) => i.provider === filterProvider);
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
      if (sort === "provider") return a.providerName.localeCompare(b.providerName);
      return a.title.localeCompare(b.title);
    });
    return sorted;
  }, [items, filterProvider, filterQuality, search, sort]);

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
            onConnect={() => setLoginProvider(p)}
            onScrape={() => scrape(p.id, p.name)}
            onDisconnect={() => disconnect(p.id, p.name)}
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
          {connectedProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
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
        Showing {filtered.length} of {items.length} titles
      </p>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="big">🍿</div>
          <p>
            {items.length === 0
              ? "No titles yet. Connect a service above, then hit “Sync library”."
              : "No titles match your filters."}
          </p>
        </div>
      ) : (
        <div className="library-grid">
          {filtered.map((item) => (
            <MediaCard
              key={`${item.provider}:${item.id}`}
              item={item}
              showProvider={filterProvider === "all"}
            />
          ))}
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
