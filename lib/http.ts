import { jitteredMs, sleep } from "./jitter";

export class SourceError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

export async function fetchText(url: string, init?: RequestInit, attempt = 0): Promise<string> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("user-agent", "new-grad-finder/0.1 (personal new-grad job search)");
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(25_000),
  });
  if ((res.status === 429 || res.status === 503) && attempt < 1) {
    await sleep(jitteredMs(8_000, 0.35));
    return fetchText(url, init, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new SourceError(`${res.status} for ${url}`, res.status);
  return text;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const text = await fetchText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError(`invalid JSON from ${url}`);
  }
}
