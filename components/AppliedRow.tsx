"use client";

import { useState, type ReactNode } from "react";

export const HIDE_REASONS = ["Not eligible", "Not interested", "Posting closed", "Other"];

// A table row that leaves the current list once acted on.
// - "jobs": an Applied checkbox (marks the job applied) and a Hide button with a reason.
// - "applied": the Applied checkbox, ticked; unticking moves the job back to Jobs.
// - "hidden": an Unhide button that moves the job back to Jobs.
export function AppliedRow({
  jobId,
  mode,
  children,
}: {
  jobId: string;
  mode: "jobs" | "applied" | "hidden";
  children: ReactNode;
}) {
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [reason, setReason] = useState(HIDE_REASONS[0]);

  async function send(request: Promise<Response>) {
    setBusy(true);
    setError("");
    const res = await request;
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not save");
      return;
    }
    setMoved(true);
  }

  const save = (status: string, notes?: string) =>
    send(
      fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, status, notes }),
      }),
    );
  const remove = () => send(fetch(`/api/applications/${encodeURIComponent(jobId)}`, { method: "DELETE" }));

  return (
    <tr hidden={moved}>
      {children}
      <td>
        {mode === "hidden" ? (
          <button className="btn" type="button" disabled={busy} onClick={() => void remove()}>
            Unhide
          </button>
        ) : (
          <label className="row-actions">
            <input
              type="checkbox"
              checked={mode === "applied"}
              disabled={busy}
              onChange={() => void (mode === "applied" ? remove() : save("applied"))}
            />
            Applied
          </label>
        )}
        {mode === "jobs" && !choosing ? (
          <button className="btn" type="button" disabled={busy} onClick={() => setChoosing(true)}>
            Hide
          </button>
        ) : null}
        {mode === "jobs" && choosing ? (
          <div className="row-actions">
            <select value={reason} onChange={(event) => setReason(event.target.value)}>
              {HIDE_REASONS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <button className="btn danger" type="button" disabled={busy} onClick={() => void save("hidden", reason)}>
              Hide
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setChoosing(false)}>
              Cancel
            </button>
          </div>
        ) : null}
        {error ? <span className="sub">{error}</span> : null}
      </td>
    </tr>
  );
}
