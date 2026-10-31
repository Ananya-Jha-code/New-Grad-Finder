"use client";

import { useState } from "react";

export function PollButton({ targetId, label, primary = false }: { targetId?: string; label: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    const res = await fetch("/api/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      dispatched?: boolean;
      jobsNew?: number;
      jobsSeen?: number;
    };
    if (!res.ok) {
      setState("error");
      setMessage(data.error || "Poll failed");
      return;
    }
    setState("done");
    if (data.dispatched) {
      setMessage("Started on GitHub Actions. New jobs show up here in about 10 minutes.");
      return;
    }
    setMessage(`${data.jobsNew ?? 0} new of ${data.jobsSeen ?? 0} seen`);
    window.setTimeout(() => window.location.reload(), 700);
  }

  return (
    <span className="row-actions">
      <button className={primary ? "btn primary" : "btn"} type="button" onClick={run} disabled={state === "running"}>
        {state === "running" ? "Polling…" : label}
      </button>
      {message ? <span className={state === "error" ? "note" : "ok"}>{message}</span> : null}
    </span>
  );
}
