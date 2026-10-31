export function jitteredMs(baseMs: number, ratio = 0.2): number {
  const span = Math.min(0.9, Math.max(0, ratio));
  const delta = baseMs * span;
  const value = baseMs + (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
