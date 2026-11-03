import type { Ats, JobDraft, Target, TargetInput } from "./types";
import { fetchJson, fetchText, SourceError } from "./http";
import { jitteredMs, sleep } from "./jitter";

export type RemoteJob = {
  externalId: string;
  title: string;
  url: string;
  location: string | null;
  postedAt: string | null;
  company?: string;
};

type GreenhouseJob = {
  id?: number;
  title?: string;
  absolute_url?: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  location?: { name?: string };
};

export async function fetchGreenhouse(token: string): Promise<RemoteJob[]> {
  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  );
  return (data.jobs ?? []).flatMap((job) => {
    if (!job.absolute_url || !job.title) return [];
    return [
      {
        externalId: String(job.id ?? job.absolute_url),
        title: job.title,
        url: job.absolute_url,
        location: job.location?.name ?? null,
        postedAt: job.first_published ?? job.updated_at ?? null,
        company: job.company_name,
      },
    ];
  });
}

type LeverJob = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  categories?: { location?: string };
};

export async function fetchLever(token: string): Promise<RemoteJob[]> {
  const data = await fetchJson<LeverJob[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
  );
  if (!Array.isArray(data)) return [];
  return data.flatMap((job) => {
    if (!job.hostedUrl || !job.text) return [];
    return [
      {
        externalId: job.id ?? job.hostedUrl,
        title: job.text,
        url: job.hostedUrl,
        location: job.categories?.location ?? null,
        postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      },
    ];
  });
}

type WorkdayPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};

// postedOn is relative text: "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago".
function olderThanYesterday(postedOn: string | undefined): boolean {
  return /\d+\+? Days? Ago/i.test(postedOn ?? "");
}

export async function fetchWorkday(host: string, tenant: string, site: string): Promise<RemoteJob[]> {
  // Workday search is the slow source, so it asks only for new-grad terms, 3 pages each.
  // Term results are ranked by relevance, so a new posting can sit beyond page 3; a blank
  // search is ranked newest first, so it is read too, until it reaches older postings.
  // "university" is left out: on most sites it finds recruiters and education sales.
  const queries = ["", "new grad", "graduate", "early career", "entry level"];
  const seen = new Map<string, RemoteJob>();
  for (const searchText of queries) {
    for (let offset = 0; offset < 60; offset += 20) {
      const data = await fetchJson<{ jobPostings?: WorkdayPosting[] }>(
        `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
        },
      );
      const postings = data.jobPostings ?? [];
      for (const job of postings) {
        if (!job.title || !job.externalPath) continue;
        const path = job.externalPath.startsWith("/") ? job.externalPath : `/${job.externalPath}`;
        const url = `https://${host}/${site}${path}`;
        if (!seen.has(job.externalPath)) {
          seen.set(job.externalPath, {
            externalId: job.bulletFields?.[0] ?? job.externalPath,
            title: job.title,
            url,
            location: job.locationsText ?? null,
            postedAt: job.postedOn ?? null,
          });
        }
      }
      if (postings.length < 20) break;
      if (!searchText && olderThanYesterday(postings.at(-1)?.postedOn)) break;
    }
  }
  return [...seen.values()];
}

type AshbyJob = {
  id?: string;
  title?: string;
  jobUrl?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
};

export async function fetchAshby(name: string): Promise<RemoteJob[]> {
  const data = await fetchJson<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}`,
  );
  return (data.jobs ?? []).flatMap((job) => {
    if (!job.jobUrl || !job.title || job.isListed === false) return [];
    const places = [job.location, ...(job.secondaryLocations ?? []).map((item) => item.location)].filter(Boolean);
    return [
      {
        externalId: job.id ?? job.jobUrl,
        title: job.title,
        url: job.jobUrl,
        location: places.length ? places.join("; ") : null,
        postedAt: job.publishedAt ?? null,
      },
    ];
  });
}

type SmartRecruitersPosting = {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; country?: string };
};

// [search text, most postings read]. Results come newest first, so the blank search sees
// every new posting; the terms find older new-grad postings on a board's first poll.
const SMARTRECRUITERS_QUERIES: Array<[string, number]> = [
  ["", 200],
  ["new grad", 100],
  ["graduate", 100],
  ["early career", 100],
];

export async function fetchSmartRecruiters(company: string): Promise<RemoteJob[]> {
  // Full boards run to thousands of postings, so only the newest and new-grad searches are read.
  const seen = new Map<string, RemoteJob>();
  for (const [query, max] of SMARTRECRUITERS_QUERIES) {
    for (let offset = 0; offset < max; offset += 100) {
      const data = await fetchJson<{ content?: SmartRecruitersPosting[] }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?q=${encodeURIComponent(query)}&limit=100&offset=${offset}`,
      );
      const page = data.content ?? [];
      for (const job of page) {
        if (!job.id || !job.name || seen.has(job.id)) continue;
        const loc = job.location;
        seen.set(job.id, {
          externalId: job.id,
          title: job.name,
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${job.id}`,
          location: loc?.fullLocation?.replace(/,\s*,/g, ",") || [loc?.city, loc?.country].filter(Boolean).join(", ") || null,
          postedAt: job.releasedDate ?? null,
        });
      }
      if (page.length < 100) break;
    }
  }
  return [...seen.values()];
}

type EightfoldPosition = {
  id?: number;
  name?: string;
  location?: string;
  locations?: string[];
  t_create?: number;
  postedTs?: number;
  canonicalPositionUrl?: string;
  positionUrl?: string;
};

function eightfoldJob(host: string, job: EightfoldPosition): RemoteJob | null {
  if (!job.id || !job.name) return null;
  const path = job.positionUrl ?? `/careers/job/${job.id}`;
  const created = job.t_create ?? job.postedTs;
  return {
    externalId: String(job.id),
    title: job.name,
    url: job.canonicalPositionUrl ?? `https://${host}${path}`,
    location: job.locations?.length ? job.locations.join("; ") : job.location ?? null,
    postedAt: created ? new Date(created * 1000).toISOString() : null,
  };
}

// [search text, most postings read]. Eightfold search is fuzzy ("new grad" also finds
// senior roles), so the title filter does the sorting; the blank search is newest first.
const EIGHTFOLD_QUERIES: Array<[string, number]> = [
  ["", 50],
  ["new grad", 30],
  ["graduate", 30],
  ["early career", 30],
];

// Eightfold sites (Netflix, Qualcomm, ...) serve an older jobs API, or a newer "PCSX"
// one that needs the company's domain. Both page 10 results at a time.
export async function fetchEightfold(host: string): Promise<RemoteJob[]> {
  const base = `https://${host}/api`;
  const labels = host.split(".");
  const domain = host.endsWith(".eightfold.ai") ? `${labels[0]}.com` : labels.slice(-2).join(".");
  let newer = false;
  const pageOf = async (query: string, start: number): Promise<{ positions: EightfoldPosition[]; count: number }> => {
    if (!newer) {
      try {
        const older = await fetchJson<{ positions?: EightfoldPosition[]; count?: number }>(
          `${base}/apply/v2/jobs?query=${encodeURIComponent(query)}&start=${start}&num=10`,
        );
        if (Array.isArray(older.positions)) return { positions: older.positions, count: older.count ?? 0 };
      } catch (err) {
        // Sites on the newer API answer the older one with 401/403 "Not authorized for PCSX".
        if (!(err instanceof SourceError && (err.status === 401 || err.status === 403))) throw err;
      }
      newer = true;
    }
    const page = await fetchJson<{ data?: { positions?: EightfoldPosition[]; count?: number } }>(
      `${base}/pcsx/search?domain=${encodeURIComponent(domain)}&query=${encodeURIComponent(query)}&location=&start=${start}`,
    );
    return { positions: page.data?.positions ?? [], count: page.data?.count ?? 0 };
  };
  const seen = new Map<string, RemoteJob>();
  for (const [query, max] of EIGHTFOLD_QUERIES) {
    for (let start = 0; start < max; start += 10) {
      const { positions, count } = await pageOf(query, start);
      for (const job of positions) {
        const found = eightfoldJob(host, job);
        if (found && !seen.has(found.externalId)) seen.set(found.externalId, found);
      }
      if (positions.length < 10 || start + 10 >= count) break;
      await sleep(jitteredMs(600, 0.3));
    }
  }
  return [...seen.values()];
}

type OracleRequisition = {
  Id?: string;
  Title?: string;
  PrimaryLocation?: string;
  PostedDate?: string;
  secondaryLocations?: Array<{ Name?: string }>;
};

// [keyword, most postings read]. The blank search is sorted newest first; keyword
// searches keep Oracle's relevance order, which puts graduate programs on top.
const ORACLE_QUERIES: Array<[string, number]> = [
  ["", 200],
  ["graduate", 100],
  ["early career", 100],
];

// Oracle Recruiting Cloud: one public REST API shared by every company on it.
export async function fetchOracle(host: string, site: string): Promise<RemoteJob[]> {
  const seen = new Map<string, RemoteJob>();
  for (const [keyword, max] of ORACLE_QUERIES) {
    const sort = keyword ? "" : ",sortBy=POSTING_DATES_DESC";
    for (let offset = 0; offset < max; offset += 100) {
      const finder = `findReqs;siteNumber=${site},keyword=${keyword},limit=100,offset=${offset}${sort}`;
      const data = await fetchJson<{ items?: Array<{ TotalJobsCount?: number; requisitionList?: OracleRequisition[] }> }>(
        `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`,
      );
      const page = data.items?.[0];
      const list = page?.requisitionList ?? [];
      for (const job of list) {
        if (!job.Id || !job.Title || seen.has(job.Id)) continue;
        const places = [job.PrimaryLocation, ...(job.secondaryLocations ?? []).map((item) => item.Name)].filter(Boolean);
        seen.set(job.Id, {
          externalId: job.Id,
          title: job.Title,
          url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${job.Id}`,
          location: places.length ? [...new Set(places)].join("; ") : null,
          postedAt: job.PostedDate ?? null,
        });
      }
      if (list.length < 100 || offset + 100 >= (page?.TotalJobsCount ?? 0)) break;
    }
  }
  return [...seen.values()];
}

type AmazonJob = { id_icims?: string; title?: string; normalized_location?: string; posted_date?: string; job_path?: string };

// [search text, most postings read]. Amazon names its new-grad roles "Early Career - 2027"
// or "Jr."; its is_intern and university_job fields are always empty. The blank search,
// sorted newest first, covers about the last two days of postings.
const AMAZON_QUERIES: Array<[string, number]> = [
  ["", 200],
  ["early career", 200],
  ["2027", 200],
  ["university graduate", 100],
  ["jr", 100],
];

export async function fetchAmazon(): Promise<RemoteJob[]> {
  const seen = new Map<string, RemoteJob>();
  for (const [query, max] of AMAZON_QUERIES) {
    for (let offset = 0; offset < max; offset += 100) {
      const data = await fetchJson<{ hits?: number; jobs?: AmazonJob[] }>(
        `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(query)}&country=USA&sort=recent&result_limit=100&offset=${offset}`,
      );
      const page = data.jobs ?? [];
      for (const job of page) {
        if (!job.title || !job.job_path) continue;
        const externalId = job.id_icims ?? job.job_path;
        if (seen.has(externalId)) continue;
        const posted = job.posted_date ? Date.parse(job.posted_date) : NaN;
        seen.set(externalId, {
          externalId,
          title: job.title,
          url: `https://www.amazon.jobs${job.job_path}`,
          location: job.normalized_location ?? null,
          postedAt: Number.isFinite(posted) ? new Date(posted).toISOString() : null,
        });
      }
      if (page.length < 100 || offset + 100 >= (data.hits ?? 0)) break;
    }
  }
  return [...seen.values()];
}

type TikTokPlace = { en_name?: string; parent?: TikTokPlace | null };
type TikTokJob = { id?: string; title?: string; city_info?: TikTokPlace | null };

// TikTok's careers site API; the website-path header is what its own page sends.
// New-grad roles are titled "... Graduate ... - 2027 Start".
export async function fetchTikTok(): Promise<RemoteJob[]> {
  const jobs: RemoteJob[] = [];
  for (let offset = 0; offset < 4000; offset += 100) {
    const data = await fetchJson<{ data?: { count?: number; job_post_list?: TikTokJob[] } }>(
      "https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts",
      {
        method: "POST",
        headers: { "content-type": "application/json", "website-path": "tiktok" },
        body: JSON.stringify({ keyword: "graduate", limit: 100, offset }),
      },
    );
    const page = data.data?.job_post_list ?? [];
    for (const job of page) {
      if (!job.id || !job.title) continue;
      const places: string[] = [];
      for (let place = job.city_info; place && places.length < 4; place = place.parent) {
        if (place.en_name) places.push(place.en_name);
      }
      jobs.push({
        externalId: job.id,
        title: job.title,
        url: `https://lifeattiktok.com/search/${job.id}`,
        location: places.length ? places.join(", ") : null,
        postedAt: null,
      });
    }
    if (page.length < 100 || offset + 100 >= (data.data?.count ?? 0)) break;
    await sleep(jitteredMs(500, 0.3));
  }
  return jobs;
}

type Listing = {
  id?: string;
  title?: string;
  company_name?: string;
  url?: string;
  locations?: string[];
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
  category?: string;
  degrees?: string[];
};

const AGE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, mo: 30 * 86_400_000 };

// Ages read "6d" (speedyapply) or "12m", "3h", "1w", "1mo" (Zapply); Zapply also gives dates.
function postedFromAge(cell: string, now: number): number | undefined {
  const age = cell.match(/^(\d+)\s*(mo|m|h|d|w)$/);
  if (age) return Math.floor((now - Number(age[1]) * AGE_UNIT_MS[age[2]]) / 1000);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(cell) ? Date.parse(cell) : NaN;
  return Number.isFinite(date) ? Math.floor(date / 1000) : undefined;
}

// Zapply links are redirects whose id names the source ("greenhouse-verkada-5280545007",
// "ashby-handshake-<uuid>"). Those are turned into the board's own link, so the job matches
// the same posting from the board and the board can be discovered; others stay as given.
export function zapplyDirectUrl(raw: string): string {
  const id = raw.match(/zapply\.jobs\/l\/d\/([^/?#]+)/)?.[1];
  if (!id) return raw;
  const greenhouse = id.match(/^greenhouse-([a-z0-9]+)-(\d+)$/i);
  if (greenhouse) return `https://job-boards.greenhouse.io/${greenhouse[1]}/jobs/${greenhouse[2]}`;
  const uuid = id.match(/^(ashby|lever)-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuid) return uuid[1] === "ashby" ? `https://jobs.ashbyhq.com/${uuid[2]}/${uuid[3]}` : `https://jobs.lever.co/${uuid[2]}/${uuid[3]}`;
  return raw.replace(/\?.*$/, "");
}

// speedyapply (FAANG+, Quant, Other) and Zapply (one table per role group) publish Markdown
// tables instead of JSON. Columns are found by header name because the tables differ.
export function parseMarkdownListings(markdown: string, now = Date.now()): Listing[] {
  const text = (cell: string) => cell.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").trim();
  const items: Listing[] = [];
  let columns: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      columns = [];
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Company") {
      columns = cells.map((cell) => text(cell).toLowerCase());
      continue;
    }
    if (columns.length === 0 || cells.every((cell) => /^-*$/.test(cell))) continue;
    const at = (name: string) => (columns.includes(name) ? cells[columns.indexOf(name)] ?? "" : "");
    const link = at("posting") || at("apply");
    const href = link.match(/href="([^"]+)"/)?.[1] ?? link.match(/\]\((https?:\/\/[^)\s]+)\)/)?.[1];
    const company = text(at("company"));
    const title = text(at("position") || at("role"));
    if (!href || !company || !title) continue;
    const url = zapplyDirectUrl(href);
    items.push({
      id: url,
      title,
      company_name: company,
      url,
      locations: text(at("location")) ? [text(at("location"))] : [],
      date_posted: postedFromAge(text(at("age") || at("posted")), now),
      active: true,
    });
  }
  return items;
}

type ListFeed = {
  company: string;
  url: string;
  keep: (item: Listing) => boolean;
  parse?: (body: string) => Listing[];
  // false for lists that mix in internships and senior roles: their titles go through the
  // same checks as board titles instead of being trusted as new-grad roles.
  curated?: boolean;
};

// 2027 new-grad hiring opened in summer 2026; older postings still marked active are
// mostly leftovers from the 2026 cycle.
export const LIST_MAX_AGE_DAYS = 120;

export function listedRecently(item: Listing, now = Date.now()): boolean {
  return !item.date_posted || now - item.date_posted * 1000 <= LIST_MAX_AGE_DAYS * 86_400_000;
}

// Simplify tags each listing with a category and the degrees it accepts.
const SIMPLIFY_SKIP_CATEGORIES = new Set(["Hardware", "Product"]);

export function simplifyKeep(item: Listing, now = Date.now()): boolean {
  if (item.category && SIMPLIFY_SKIP_CATEGORIES.has(item.category)) return false;
  const degrees = item.degrees ?? [];
  if (degrees.length > 0 && degrees.every((degree) => degree === "PhD" || degree === "MBA")) return false;
  return listedRecently(item, now);
}

// Community lists of open new-grad roles. SimplifyJobs and vanshb03 publish the same
// listings.json shape; speedyapply's and Zapply's tables are parsed from their Markdown.
// Zapply rows without a date are mostly old postings, so they are skipped.
const zapplyKeep = (item: Listing) => item.date_posted !== undefined && listedRecently(item);

export const LIST_FEEDS: Record<string, ListFeed> = {
  simplify: {
    company: "SimplifyJobs list",
    url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    keep: (item) => simplifyKeep(item),
  },
  vansh: {
    company: "vanshb03 list",
    url: "https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json",
    keep: (item) => listedRecently(item),
  },
  speedyapply: {
    company: "speedyapply list",
    url: "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md",
    keep: (item) => listedRecently(item),
    parse: (body) => parseMarkdownListings(body),
  },
  zapply_swe: {
    company: "Zapply SWE list",
    url: "https://raw.githubusercontent.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2027/main/README.md",
    keep: zapplyKeep,
    parse: (body) => parseMarkdownListings(body),
    curated: false,
  },
  zapply_data: {
    company: "Zapply data science list",
    url: "https://raw.githubusercontent.com/zapplyjobs/New-Grad-Data-Science-Jobs-2027/main/README.md",
    keep: zapplyKeep,
    parse: (body) => parseMarkdownListings(body),
    curated: false,
  },
};

// Whether jobs from this list are trusted as new-grad roles (see ListFeed.curated).
export function curatedList(feed: string): boolean {
  return LIST_FEEDS[feed]?.curated !== false;
}

export type ListResult = { jobs: RemoteJob[]; boards: TargetInput[] };

// Board links inside a list become targets, which is how new companies are found.
export function boardFromUrl(company: string, raw: string): TargetInput | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const first = decodeURIComponent(url.pathname.split("/")[1] ?? "");
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const token = first === "embed" ? url.searchParams.get("for") : first;
    return token ? { company, ats: "greenhouse", boardToken: token } : null;
  }
  if (host === "jobs.lever.co" && first) return { company, ats: "lever", boardToken: first };
  if (host === "jobs.ashbyhq.com" && first) return { company, ats: "ashby", boardToken: first };
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && first) {
    return { company, ats: "smartrecruiters", boardToken: first };
  }
  const oracle = raw.match(/^https:\/\/([^/]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([^/?#]+)/i);
  if (oracle) return { company, ats: "oracle", workdayHost: oracle[1], workdaySite: oracle[2] };
  // A Greenhouse job on the company's own domain (?gh_jid=) does not name the board; guess
  // it from the company name. Wrong guesses answer 404 on their first poll and switch off.
  if (url.searchParams.has("gh_jid")) {
    const token = company.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
    return token ? { company, ats: "greenhouse", boardToken: token } : null;
  }
  // Eightfold job links look like https://<host>/careers/job/<12-digit id>.
  if (host.endsWith(".eightfold.ai") || /^\/careers\/job\/\d{11,}/.test(url.pathname)) {
    return { company, ats: "eightfold", boardToken: host };
  }
  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) {
    const parts = url.pathname.split("/").filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts[1] : parts[0];
    return site ? { company, ats: "workday", workdayHost: host, workdayTenant: wd[1], workdaySite: site } : null;
  }
  return null;
}

export async function fetchList(feed: string): Promise<ListResult> {
  const config = LIST_FEEDS[feed];
  if (!config) throw new Error(`unknown list feed ${feed}`);
  const items = config.parse ? config.parse(await fetchText(config.url)) : await fetchJson<Listing[]>(config.url);
  if (!Array.isArray(items)) throw new Error(`${feed} list is not an array`);
  const jobs: RemoteJob[] = [];
  const boards = new Map<string, TargetInput>();
  for (const item of items) {
    if (!item.url || !item.title || !item.company_name) continue;
    const board = boardFromUrl(item.company_name, item.url);
    if (board) boards.set(`${board.ats}:${board.boardToken ?? board.workdayHost}`.toLowerCase(), board);
    if (!item.active || item.is_visible === false || !config.keep(item)) continue;
    jobs.push({
      externalId: item.id ?? item.url,
      title: item.title,
      url: item.url,
      location: item.locations?.length ? item.locations.join("; ") : null,
      postedAt: item.date_posted ? new Date(item.date_posted * 1000).toISOString() : null,
      company: item.company_name,
    });
  }
  return { jobs, boards: [...boards.values()] };
}

export async function fetchTargetJobs(target: Target): Promise<RemoteJob[]> {
  if (target.ats === "greenhouse") {
    if (!target.boardToken) throw new Error("greenhouse target is missing a board token");
    return fetchGreenhouse(target.boardToken);
  }
  if (target.ats === "lever") {
    if (!target.boardToken) throw new Error("lever target is missing a board token");
    return fetchLever(target.boardToken);
  }
  if (target.ats === "ashby") {
    if (!target.boardToken) throw new Error("ashby target is missing a board token");
    return fetchAshby(target.boardToken);
  }
  if (target.ats === "smartrecruiters") {
    if (!target.boardToken) throw new Error("smartrecruiters target is missing a company id");
    return fetchSmartRecruiters(target.boardToken);
  }
  if (target.ats === "oracle") {
    if (!target.workdayHost || !target.workdaySite) throw new Error("oracle target is missing host or site");
    return fetchOracle(target.workdayHost, target.workdaySite);
  }
  if (target.ats === "amazon") return fetchAmazon();
  if (target.ats === "tiktok") return fetchTikTok();
  if (target.ats === "eightfold") {
    if (!target.boardToken) throw new Error("eightfold target is missing a host");
    return fetchEightfold(target.boardToken);
  }
  if (target.ats === "list") {
    if (!target.boardToken) throw new Error("list target is missing a feed name");
    return (await fetchList(target.boardToken)).jobs;
  }
  if (!target.workdayHost || !target.workdayTenant || !target.workdaySite) {
    throw new Error("workday target is missing host, tenant, or site");
  }
  return fetchWorkday(target.workdayHost, target.workdayTenant, target.workdaySite);
}

export function toDrafts(target: Target, jobs: RemoteJob[]): { drafts: JobDraft[]; skipped: number } {
  const drafts: JobDraft[] = [];
  let skipped = 0;
  for (const job of jobs) {
    try {
      const url = new URL(job.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        skipped++;
        continue;
      }
      drafts.push({
        company: job.company?.trim() || target.company,
        title: job.title.trim(),
        location: job.location?.trim() || null,
        url: job.url,
        ats: target.ats as Ats,
        targetId: target.id,
        externalId: job.externalId,
        postedAt: job.postedAt,
      });
    } catch {
      skipped++;
    }
  }
  return { drafts, skipped };
}
