import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { getVersion } from "./version.js";
import { createLogger } from "./logger.js";
import { ensureDataDirs } from "./services/paths.js";
import { closeBrowser } from "./services/browser.js";
import { authRouter, requireAuth } from "./routes/auth.js";
import { providersRouter } from "./routes/providers.js";
import { libraryRouter } from "./routes/library.js";

const log = createLogger("server");
const __dirname = dirname(fileURLToPath(import.meta.url));

ensureDataDirs();

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Public endpoints (no auth) ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/version", (_req, res) => res.json(getVersion()));
app.use("/api/auth", authRouter);

// --- Protected API ---
app.use("/api/providers", requireAuth, providersRouter);
app.use("/api/library", requireAuth, libraryRouter);

// --- Serve the built frontend (single-container deploy) ---
const webDistCandidates = [
  join(__dirname, "..", "..", "web", "dist"),
  join(__dirname, "..", "public"),
  join(process.cwd(), "web", "dist"),
];
const webDist = webDistCandidates.find((p) => existsSync(join(p, "index.html")));

if (webDist) {
  log.info(`Serving frontend from ${webDist}`);
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, "index.html"));
  });
} else {
  log.warn("No built frontend found. Run `npm run build:web` (API-only mode).");
  app.get("/", (_req, res) =>
    res.type("text/plain").send("API is running. Build the web app to see the UI.")
  );
}

const version = getVersion();
const server = app.listen(config.port, () => {
  log.info(
    `MovieTVScraperLists v${version.version} (build ${version.build}) listening on :${config.port}`
  );
});

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down...`);
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
