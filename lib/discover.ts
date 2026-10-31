import type { TargetInput } from "./types";
import { jitteredMs, sleep } from "./jitter";

// Finds startup job boards the new-grad lists never link to. Runs weekly on its own
// (npm run discover), not inside the poll: these sources change monthly, and Common
// Crawl's index is slow and often answers 504.

const BOARD_RE =
  /(jobs\.ashbyhq\.com|jobs\.lever\.co|(?:job-)?boards\.greenhouse\.io|jobs\.smartrecruiters\.com)\/(?:embed\/job_app\?for=)?([A-Za-z0-9._-]+)/g;

const NOT_BOARDS = new Set(["embed", "v1", "api", "jobs", "careers", "search", "job_app"]);

function toTarget(host: string, slug: string, company: string): TargetInput | null {
  if (NOT_BOARDS.has(slug.toLowerCase())) return null;
  const ats = host.includes("ashby")
    ? "ashby"
    : host.includes("lever")
      ? "lever"
      : host.includes("smartrecruiters")
        ? "smartrecruiters"
        : "greenhouse";
  return { company: company || slug, ats, boardToken: slug };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Board links in one "Who is hiring?" comment. Posts conventionally start
// "Company | Role | Location", so the company is the text before the first pipe.
export function boardsFromHnComment(html: string): TargetInput[] {
  const text = decodeEntities(html);
  const firstLine = text.replace(/<[^>]+>/g, "\n").split("\n")[0] ?? "";
  const company = firstLine.split("|")[0].trim().slice(0, 80);
  const found: TargetInput[] = [];
  for (const [, host, slug] of text.matchAll(BOARD_RE)) {
    const target = toTarget(host, slug, company);
    if (target) found.push(target);
  }
  return found;
}

// One Common Crawl index line is a JSON object with the captured url.
export function boardFromCrawlLine(line: string): TargetInput | null {
  let url: string;
  try {
    url = (JSON.parse(line) as { url?: string }).url ?? "";
  } catch {
    return null;
  }
  const match = [...url.matchAll(BOARD_RE)][0];
  return match ? toTarget(match[1], match[2], "") : null;
}

const UA = "new-grad-finder/0.1 (personal new-grad job search)";

async function getText(url: string, timeoutMs: number, tries = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.text();
      if (res.status !== 503 && res.status !== 504 && res.status !== 429) throw new Error(`${res.status} for ${url}`);
      if (attempt >= tries) throw new Error(`${res.status} for ${url}`);
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    await sleep(jitteredMs(15_000 * attempt, 0.3));
  }
}

export async function hnBoards(months = 12): Promise<TargetInput[]> {
  const search = JSON.parse(
    await getText("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=50", 30_000),
  ) as { hits?: Array<{ objectID: string; title: string }> };
  const threads = (search.hits ?? []).filter((hit) => hit.title.startsWith("Ask HN: Who is hiring?")).slice(0, months);
  const found: TargetInput[] = [];
  for (const thread of threads) {
    const item = JSON.parse(await getText(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, 60_000)) as {
      children?: Array<{ text?: string | null }>;
    };
    for (const comment of item.children ?? []) found.push(...boardsFromHnComment(comment.text ?? ""));
  }
  return found;
}

const CRAWL_PATTERNS = ["jobs.ashbyhq.com/*", "jobs.lever.co/*", "job-boards.greenhouse.io/*", "boards.greenhouse.io/*"];

// Best effort: each pattern that keeps timing out is skipped and listed in `skipped`.
export async function crawlBoards(crawls = 2): Promise<{ boards: TargetInput[]; skipped: string[] }> {
  const boards: TargetInput[] = [];
  const skipped: string[] = [];
  const info = JSON.parse(await getText("https://index.commoncrawl.org/collinfo.json", 30_000)) as Array<{ id: string }>;
  for (const { id } of info.slice(0, crawls)) {
    for (const pattern of CRAWL_PATTERNS) {
      const base = `https://index.commoncrawl.org/${id}-index?url=${encodeURIComponent(pattern)}&output=json&fl=url`;
      try {
        const { pages } = JSON.parse(await getText(`${base}&showNumPages=true`, 120_000)) as { pages?: number };
        for (let page = 0; page < Math.min(pages ?? 0, 20); page++) {
          for (const line of (await getText(`${base}&page=${page}`, 180_000)).split("\n")) {
            const board = boardFromCrawlLine(line);
            if (board) boards.push(board);
          }
          await sleep(jitteredMs(2_000, 0.3));
        }
      } catch {
        skipped.push(`${id} ${pattern}`);
      }
    }
  }
  return { boards, skipped };
}
