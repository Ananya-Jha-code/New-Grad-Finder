"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setError("Wrong password");
      return;
    }
    window.location.href = "/";
  }
  return (
    <form className="card login stack" onSubmit={onSubmit}>
      <h1 className="brand">New Grad Finder</h1>
      <label>
        Password
        <input name="password" type="password" required autoFocus />
      </label>
      <button className="btn primary" type="submit">Unlock</button>
      {error ? <span className="note">{error}</span> : null}
    </form>
  );
}
