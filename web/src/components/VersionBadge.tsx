import { useEffect, useState } from "react";
import { api } from "../api";
import type { VersionInfo } from "../types";

export function VersionBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api.version().then(setV).catch(() => setV(null));
  }, []);

  if (!v) return null;
  const released = new Date(v.releasedAt).toLocaleString();
  return (
    <span
      className="version-badge"
      title={`Build ${v.build}${v.codename ? ` · ${v.codename}` : ""}\nReleased ${released}`}
    >
      <b>v{v.version}</b> · build {v.build}
    </span>
  );
}
