# 🎞️ MovieTVScraperLists

A self-hosted web app that logs into your movie/TV purchase accounts, scrapes your
**purchased library**, and shows everything you own in one modern, Apple-style
interface — with CSV/JSON export.

Supported services:

| Service | Status |
| --- | --- |
| **Fandango at Home** | ✅ Implemented |
| **Movies Anywhere** | 🚧 Framework ready (coming next) |
| **Apple TV** | 🚧 Framework ready (coming next) |
| **Google Play / YouTube** | 🚧 Framework ready (coming next) |
| **Prime Video** | 🚧 Framework ready (coming next) |

> **How it works:** none of these services offer a public "list my library" API,
> so the app logs in *as you* using a real browser engine (Playwright) and reads
> your library pages. You log in once through the app (entering any 2-factor code);
> the session is saved **encrypted** and reused for future syncs.

---

## ✨ Features

- **Apple-style UI** — rounded buttons, drop shadows, frosted panels, **dark mode by default** (with a light toggle).
- **Assisted login** with full 2-factor support, handled right in the web UI.
- **One combined library** across all connected services, with search, filters (service / quality) and sorting.
- **Export** the whole list or a single service to **CSV** or **JSON**.
- **Version badge** on the page — every build bumps the number so you always know what's live.
- **Single container** — API + web served together. Ready for Portainer + Caddy.

---

## 🚀 Quick start (local development)

```bash
# 1. Install dependencies (downloads the Chromium browser for scraping)
npm install

# 2. Create your .env from the template and set a SESSION_SECRET
cp .env.example .env

# 3. Run the API + web app together (API on :8088, web dev server on :5173)
npm run dev
```

Then open http://localhost:5173. Click **Connect** on Fandango at Home, sign in
(enter the emailed code if prompted), then hit **Sync library**.

### Production build (single server on :8088)

```bash
npm run build   # bumps the build number, builds web + server
npm start       # serves the app + API on http://localhost:8088
```

---

## 📦 Versioning

`version.json` holds the current `version` + `build` number, shown live on the page.

```bash
npm run bump            # +1 build number
npm run bump -- --patch # 0.1.0 -> 0.1.1 (+ build)
npm run bump -- --minor # 0.1.0 -> 0.2.0 (+ build)
npm run bump -- --major # 0.1.0 -> 1.0.0 (+ build)
```

`npm run build` bumps the build number automatically, and so does the GitHub
Actions workflow on every push to `main`.

---

## 🌐 Deploying it live

The full walkthroughs live in [`docs/`](docs/):

1. **[docs/GITHUB-SETUP.md](docs/GITHUB-SETUP.md)** — create the repo, push, and let GitHub Actions build + publish the image (your "did it build?" confirmation).
2. **[docs/PORTAINER-SETUP.md](docs/PORTAINER-SETUP.md)** — deploy the container as a Portainer stack.
3. **[docs/CADDY-SETUP.md](docs/CADDY-SETUP.md)** — point your domain at it with automatic HTTPS.

---

## 🔧 Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8088` | Port the app listens on |
| `DATA_DIR` | `./data` | Where sessions + scraped libraries are stored |
| `SESSION_SECRET` | _(required)_ | Encrypts saved logins at rest |
| `APP_PASSWORD` | _(empty)_ | Optional password gate for the whole UI |
| `HEADLESS` | `true` | Keep `true` on servers |
| `ENABLED_PROVIDERS` | all five | Which services show in the UI |

---

## 🗂️ Project structure

```
movietvscraperlists/
├─ server/           Express + TypeScript API + Playwright scrapers
│  └─ src/
│     ├─ scrapers/   Provider interface, Fandango scraper, login state machine
│     ├─ routes/     REST API (providers, library, export, auth)
│     └─ services/   Browser, encrypted session store, library store
├─ web/              React + Vite frontend (Apple-style, dark mode)
├─ scripts/          Version bump script
├─ docs/             GitHub / Portainer / Caddy setup guides
├─ Dockerfile        Multi-stage build on the Playwright base image
├─ docker-compose.yml
└─ version.json      Live version + build number
```

---

## 🛠️ Adding the remaining scrapers

Each service is a `Provider` (see `server/src/scrapers/types.ts`). `FandangoProvider`
is the reference implementation. The stub providers already appear in the UI —
replace them one at a time. On the first real login/scrape, DOM + screenshots are
saved to `data/debug/` so selectors can be tuned quickly (search the code for
`TUNE:`).

---

## ⚖️ Notes

This tool accesses **your own** accounts with **your own** credentials for personal
use. Site layouts change over time, so scrapers occasionally need selector updates.
