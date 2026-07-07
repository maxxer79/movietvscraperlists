import { Router } from "express";
import { z } from "zod";
import { enabledProviders, getProvider } from "../scrapers/registry.js";
import { hasSession, clearSession, loadSession } from "../services/sessionStore.js";
import { loadLibrary, saveLibrary } from "../services/libraryStore.js";
import { newContext } from "../services/browser.js";
import { startLogin, submitInput, cancelLogin } from "../scrapers/loginController.js";
import { SessionExpiredError } from "../scrapers/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("api");
export const providersRouter = Router();

// List providers + their status (connected? last scrape? counts?)
providersRouter.get("/", (_req, res) => {
  const list = enabledProviders().map((p) => {
    const lib = loadLibrary(p.id);
    return {
      id: p.id,
      name: p.name,
      implemented: p.implemented,
      notes: p.notes,
      connected: hasSession(p.id),
      lastScrapedAt: lib?.scrapedAt ?? null,
      itemCount: lib?.count ?? 0,
    };
  });
  res.json({ providers: list });
});

const loginStartSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

providersRouter.post("/:id/login/start", async (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  if (!provider.implemented)
    return res.status(400).json({ error: `${provider.name} is not implemented yet.` });

  const parsed = loginStartSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "username and password are required" });

  try {
    const result = await startLogin(provider, parsed.data);
    res.json(result);
  } catch (err) {
    log.error("login/start failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const loginCodeSchema = z.object({
  loginId: z.string().min(1),
  field: z.string().default("code"),
  value: z.string().min(1),
});

providersRouter.post("/:id/login/submit", async (req, res) => {
  const parsed = loginCodeSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "loginId and value are required" });
  try {
    const step = await submitInput(
      parsed.data.loginId,
      parsed.data.field,
      parsed.data.value
    );
    res.json({ step });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

providersRouter.post("/:id/login/cancel", async (req, res) => {
  const loginId = z.string().safeParse(req.body?.loginId);
  if (loginId.success) await cancelLogin(loginId.data);
  res.json({ ok: true });
});

providersRouter.post("/:id/disconnect", (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  clearSession(provider.id);
  res.json({ ok: true });
});

// Trigger a scrape using the saved session.
providersRouter.post("/:id/scrape", async (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  if (!provider.implemented)
    return res.status(400).json({ error: `${provider.name} is not implemented yet.` });

  const state = loadSession(provider.id);
  if (!state)
    return res
      .status(401)
      .json({ error: "Not connected. Please log in to this provider first." });

  const context = await newContext(state);
  try {
    const items = await provider.scrapeLibrary(context);
    const snapshot = saveLibrary(provider.id, items);
    res.json({ ok: true, snapshot });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      clearSession(provider.id);
      return res.status(401).json({ error: err.message, sessionExpired: true });
    }
    log.error(`scrape failed for ${provider.id}`, err);
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await context.close().catch(() => {});
  }
});

// Get the stored library for a provider.
providersRouter.get("/:id/library", (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  const lib = loadLibrary(provider.id);
  res.json(lib ?? { providerId: provider.id, count: 0, items: [], scrapedAt: null });
});
