import { createHash } from "node:crypto";

const TRACKING = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gh_src",
  "lever-source",
  "lever-origin",
  "ref",
  "source",
]);

export function canonicalJobUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING.has(lower) || lower.startsWith("utm_")) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/[a-z]{2}-[a-z]{2}(?=\/)/gi, "");
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function titleCacheKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|co|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// The ATS's own id for a posting, read from its URL, so the same posting found
// through a list feed and through its board collapses to one row.
export function postingKey(url: string): string | null {
  const gh = url.match(/greenhouse\.io\/.*?jobs\/(\d+)/) ?? url.match(/[?&]gh_jid=(\d+)/);
  if (gh) return `gh:${gh[1]}`;
  const uuid = url.match(/(jobs\.lever\.co|jobs\.ashbyhq\.com)\/[^/]+\/([0-9a-f]{8}-[0-9a-f-]{27})/i);
  if (uuid) return `${uuid[1].startsWith("jobs.lever") ? "lever" : "ashby"}:${uuid[2].toLowerCase()}`;
  const oracle = url.match(/\/\/([a-z0-9-]+)[^/]*oraclecloud\.com\/.*\/job\/(\d+)/i);
  if (oracle) return `or:${oracle[1].toLowerCase()}:${oracle[2]}`;
  const amazon = url.match(/amazon\.jobs\/(?:[a-z]{2}\/)?jobs\/(\d+)/);
  if (amazon) return `amzn:${amazon[1]}`;
  const tiktok = url.match(/lifeattiktok\.com\/search\/(\d{12,})/);
  if (tiktok) return `tt:${tiktok[1]}`;
  const ef = url.match(/\/careers\/job\/(\d{11,})/);
  if (ef) return `ef:${ef[1]}`;
  const sr = url.match(/smartrecruiters\.com\/[^/]+\/(\d{6,})/);
  if (sr) return `sr:${sr[1]}`;
  const wd = url.match(/\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com\/.*_([A-Za-z0-9-]*\d[A-Za-z0-9-]*)(?:[/?#]|$)/i);
  if (wd) return `wd:${wd[1].toLowerCase()}:${wd[2].toLowerCase()}`;
  return null;
}

export function roleKey(company: string, title: string): string {
  return createHash("sha256").update(`${companyKey(company)}|${titleCacheKey(title)}`).digest("hex").slice(0, 24);
}

export function dedupeKey(company: string, title: string, location: string | null): string {
  const material = [companyKey(company), titleCacheKey(title), titleCacheKey(location ?? "")].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}
