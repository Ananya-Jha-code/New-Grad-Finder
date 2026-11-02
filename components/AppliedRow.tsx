"use client";

import { useState, type ReactNode } from "react";

// A table row with an "Applied" checkbox. On the jobs list (applied=false) ticking it marks
// the job applied; on the applied list (applied=true) unticking it moves the job back.
// Either way the row leaves the current list at once.
export function AppliedRow({ jobId, applied, children }: { jobId: string; applied: boolean; children: ReactNode }) {
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    setBusy(true);
    setError("");
    const res = applied
      ? await fetch(`/api/applications/${encodeURIComponent(jobId)}`, { method: "DELETE" })
      : await fetch("/api/applications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, status: "applied" }),
        });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not save");
      return;
    }
    setMoved(true);
  }

  return (
    <tr hidden={moved}>
      {children}
      <td>
        <label className="row-actions">
          <input type="checkbox" checked={applied} disabled={busy} onChange={() => void toggle()} />
          Applied
        </label>
        {error ? <span className="sub">{error}</span> : null}
      </td>
    </tr>
  );
}
