import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { config } from "../config.js";

/** Deterministic token derived from the app password + session secret. */
function expectedToken(): string {
  return createHash("sha256")
    .update(`${config.appPassword}::${config.sessionSecret}`)
    .digest("hex");
}

export const authRouter = Router();

// Whether the UI needs to prompt for a password at all.
authRouter.get("/status", (_req, res) => {
  res.json({ required: config.appPassword.length > 0 });
});

authRouter.post("/login", (req, res) => {
  if (!config.appPassword) return res.json({ token: "", required: false });
  const password = String(req.body?.password ?? "");
  if (password !== config.appPassword) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  res.json({ token: expectedToken(), required: true });
});

/** Middleware that protects API routes when APP_PASSWORD is set. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.appPassword) return next();
  const token = req.header("x-app-token") || "";
  if (token && token === expectedToken()) return next();
  res.status(401).json({ error: "Unauthorized" });
}
