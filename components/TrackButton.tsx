"use client";

import { useState } from "react";

export function TrackButton({ jobId }: { jobId: string }) {
  const [message, setMessage] = useState("");

  async function track() {
    setMessage("Saving…");
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, status: "saved" }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setMessage(data.error || "Could not track");
      return;
    }
    window.location.href = "/applications";
  }

  return (
    <button className="btn" type="button" onClick={() => void track()}>
      {message || "Track"}
    </button>
  );
}
