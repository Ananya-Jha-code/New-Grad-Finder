const DAY_MS = 86_400_000;

// When a job was posted, as epoch ms. Most boards give a date; Workday gives relative text
// ("Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago") read against when the job
// was first seen; anything else falls back to when it was first seen.
export function postedTime(job: { postedAt: string | null; firstSeenAt: string }): number {
  const seen = Date.parse(job.firstSeenAt);
  const text = job.postedAt?.trim() ?? "";
  if (/today/i.test(text)) return seen;
  if (/yesterday/i.test(text)) return seen - DAY_MS;
  const days = text.match(/(\d+)\+?\s*days?\s*ago/i);
  if (days) return seen - Number(days[1]) * DAY_MS;
  const at = Date.parse(text);
  // Some boards report a future or nonsense date; first seen is a safer bound.
  return Number.isFinite(at) && at <= Date.now() + DAY_MS ? at : seen;
}

export function timeAgo(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

// Statuses that mean the application was sent; "saved" is only bookmarked.
export function isApplied(status: string): boolean {
  return status !== "saved";
}
