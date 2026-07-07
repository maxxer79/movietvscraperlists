import type {
  CombinedItem,
  LoginStep,
  ProviderStatus,
  VersionInfo,
} from "./types";

const TOKEN_KEY = "mtv_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-app-token": getToken(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.error || message;
      const err = new Error(message) as Error & { status?: number; body?: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status) throw e;
      throw new Error(message);
    }
  }
  return res.json() as Promise<T>;
}

export const api = {
  version: () => req<VersionInfo>("/api/version"),
  authStatus: () => req<{ required: boolean }>("/api/auth/status"),
  login: (password: string) =>
    req<{ token: string; required: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  providers: () =>
    req<{ providers: ProviderStatus[] }>("/api/providers").then((r) => r.providers),
  startLogin: (id: string, username: string, password: string) =>
    req<{ loginId: string; step: LoginStep }>(`/api/providers/${id}/login/start`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  submitLogin: (id: string, loginId: string, value: string, field = "code") =>
    req<{ step: LoginStep }>(`/api/providers/${id}/login/submit`, {
      method: "POST",
      body: JSON.stringify({ loginId, value, field }),
    }),
  disconnect: (id: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/disconnect`, { method: "POST" }),
  scrape: (id: string) =>
    req<{ ok: boolean; snapshot: { count: number } }>(
      `/api/providers/${id}/scrape`,
      { method: "POST" }
    ),
  library: () =>
    req<{ count: number; items: CombinedItem[] }>("/api/library"),
  exportUrl: (format: "csv" | "json", provider?: string) => {
    const p = new URLSearchParams({ format });
    if (provider) p.set("provider", provider);
    return `/api/library/export?${p.toString()}`;
  },
};
