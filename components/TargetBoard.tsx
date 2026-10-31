"use client";

import { useState } from "react";
import type { Target } from "@/lib/types";

export function TargetBoard({ targets }: { targets: Target[] }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ats, setAts] = useState("greenhouse");

  async function send(url: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "Request failed");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="stack">
      <form
        className="panel form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void send("/api/targets", {
            company: form.get("company"),
            ats: form.get("ats"),
            boardToken: form.get("boardToken"),
            workdayHost: form.get("workdayHost"),
            workdayTenant: form.get("workdayTenant"),
            workdaySite: form.get("workdaySite"),
            intervalMinutes: Number(form.get("intervalMinutes") || 360),
          });
        }}
      >
        <label>
          Company
          <input name="company" required placeholder="Stripe" />
        </label>
        <label>
          ATS
          <select name="ats" value={ats} onChange={(event) => setAts(event.target.value)}>
            <option value="greenhouse">Greenhouse</option>
            <option value="lever">Lever</option>
            <option value="ashby">Ashby</option>
            <option value="smartrecruiters">SmartRecruiters</option>
            <option value="eightfold">Eightfold (board token = site host)</option>
            <option value="workday">Workday</option>
          </select>
        </label>
        {ats === "workday" ? (
          <>
            <label>
              Host
              <input name="workdayHost" required placeholder="nvidia.wd5.myworkdayjobs.com" />
            </label>
            <label>
              Tenant
              <input name="workdayTenant" required placeholder="nvidia" />
            </label>
            <label>
              Site
              <input name="workdaySite" required placeholder="NVIDIAExternalCareerSite" />
            </label>
          </>
        ) : (
          <label>
            Board token
            <input name="boardToken" required placeholder="stripe" />
          </label>
        )}
        <label>
          Every (minutes)
          <input name="intervalMinutes" type="number" min={30} max={10080} defaultValue={360} />
        </label>
        <button className="btn primary" disabled={busy} type="submit">
          Add board
        </button>
      </form>

      <div className="toolbar">
        <button className="btn" type="button" disabled={busy} onClick={() => void send("/api/targets/seed", {})}>
          Load starter boards
        </button>
        <form
          className="row-actions"
          onSubmit={(event) => {
            event.preventDefault();
            const file = (event.currentTarget.elements.namedItem("csv") as HTMLInputElement).files?.[0];
            if (!file) return;
            void file.text().then((csv) => send("/api/targets/import", { csv }));
          }}
        >
          <input name="csv" type="file" accept=".csv,text/csv" />
          <button className="btn" disabled={busy} type="submit">
            Import CSV
          </button>
        </form>
        {error ? <span className="note">{error}</span> : null}
      </div>

      <div className="table-wrap">
        {targets.length === 0 ? (
          <div className="empty">No boards yet. Load the starter set or add a Greenhouse, Lever, or Workday board.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Board</th>
                <th>Last poll</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.id}>
                  <td>
                    <strong>{target.company}</strong>
                    <span className="sub">{target.enabled ? "enabled" : "paused"} · every {target.intervalMinutes}m</span>
                  </td>
                  <td>
                    <span className="pill neutral">{target.ats}</span>
                    <span className="sub">
                      {target.boardToken || `${target.workdayHost} / ${target.workdaySite}`}
                    </span>
                  </td>
                  <td>
                    {target.lastStatus === "error" ? <span className="pill bad">error</span> : target.lastStatus === "ok" ? <span className="pill">ok</span> : <span className="pill neutral">new</span>}
                    <span className="sub">{target.lastError || target.lastPolledAt || "not polled"}</span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn" type="button" disabled={busy} onClick={() => void send("/api/poll", { targetId: target.id })}>
                        Poll
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={busy}
                        onClick={() => void send(`/api/targets/${target.id}`, { enabled: !target.enabled }, "PATCH")}
                      >
                        {target.enabled ? "Pause" : "Enable"}
                      </button>
                      <button
                        className="btn danger"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Remove ${target.company}? Jobs already saved stay in the list.`)) {
                            void send(`/api/targets/${target.id}`, undefined, "DELETE");
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
