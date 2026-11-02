import type {
  Classification,
  Degree,
  Job,
  JobEvaluation,
  LocationVerdict,
  RoleFamily,
  Season,
  Seniority,
  Store,
} from "./types";
import { ROLE_FAMILIES, TARGET_FAMILIES } from "./types";
import { titleCacheKey } from "./canonicalize";
import { envInt } from "./jitter";
import { askJson, llmProviders, type LlmProvider } from "./llm";

type TitleVerdict = Omit<Classification, "cacheKey" | "title">;

const INTERN_RE = /\b(intern|interns|internships?|co-op|coop|co op)\b/i;
const NEW_GRAD_RE =
  /\b(new (college )?grad\w*|(university|college|recent) grad\w*|graduate|early[\s-]career|entry[\s-]level|junior|jr|associate|campus|residency|class of 2027|2027 start)\b/i;
// "Engineer I", "SDE 1", "Level 1"; Google-style L1 to L3 are entry levels.
const LEVEL_ONE_RE = /\b(engineer|developer|sde|swe|scientist|analyst|programmer|level)\s*[-–]?\s*(i|1)\b|\bL[1-3]\b/i;
// AI engineering titles are ML work even when the model files them under software.
const AI_ENGINEER_RE = /\b(applied ai|ai|llm|gen\s?ai|generative ai|ai\/ml|ml) engineer\w*/i;

const FAMILIES: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|\bml\b|ml engineer|deep learning|\bllm\b|\bai\b|genai|applied scientist|data scientist|data science|\bnlp\b|computer vision|ai research)\b/i, "ml"],
  [/\b(data engineer|data analyst|analytics|business intelligence|\betl\b)\b/i, "data"],
  [/\b(hardware|asic|fpga|silicon|electrical|mechanical|chip design|verification engineer)\b/i, "hardware"],
  [/\b(quant|quantitative|trading|trader)\b/i, "quant"],
  [/\b(product manager|product management|\bapm\b)\b/i, "product"],
  [/\b(designer|design|\bux\b|\bui\b)\b/i, "design"],
  [/\bresearch\b/i, "research"],
  [/\b(software|\bswe\b|backend|front[\s-]?end|full[\s-]?stack|android|\bios\b|platform|infrastructure|developer|devops|\bsre\b|security engineer|engineer)\b/i, "swe"],
];

const HIGH_SCHOOL_RE = /\bhigh school\b/i;
const AI_RESEARCH_RE =
  /\b(ai|machine learning|learning|neural|vision|robot\w*|world models?|spatial intelligence|differentiable|simulation|autonomous|generative|genai|llm|nlp|perception|multi-?modal)\b/i;

// Titles that name the job outright; the model is not consistent on some of these.
const NAMED_ROLES: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|data scien\w*)\b/i, "ml"],
  [/\bdata engineer/i, "data"],
  [/\b(software (engineer|developer)\w*|security engineer\w*)\b/i, "swe"],
];

// Engineering outside software ("Civil Engineer Intern", "GIS Intern"); the rule fallback
// and the models both tend to file these under swe.
const OFF_TARGET_RE =
  /\b(civil|structural|geotechnical|mechanical|manufacturing|chemical|chemist|process engineer\w*|project engineer\w*|field engineer\w*|safety engineer\w*|controls engineer\w*|power electronics|transmission|preconstruction|scheduling engineer\w*|sustaining engineer\w*|aerospace engineer\w*|environmental|construction|gis|geospatial|surveying|utilities)\b/i;
const SOFTWARE_TERM_RE =
  /\b(software|develop\w*|sw|programming|application|data|machine learning|ml|ai|agentic|computer science|computer vision|firmware|embedded|robot\w*|autonomy|autonomous)\b/i;
// Postdoc-style fellowships are listed beside internships but are not student roles.
const FELLOW_RE = /\b(fellow|fellowship|postdoc\w*|post-?doctoral)\b/i;

// Hard rules that override any model label: internships, high school programs, fellowships,
// and titles above entry level are out; AI engineering and research titles with AI terms
// are ML; named roles keep their family; and engineering outside software is other.
function refine(title: string, family: RoleFamily, isEntry: boolean): { family: RoleFamily; isEntry: boolean } {
  const named = NAMED_ROLES.find(([re]) => re.test(title))?.[1];
  let refined = family;
  if (AI_ENGINEER_RE.test(title)) refined = "ml";
  else if (named && !TARGET_FAMILIES.includes(family)) refined = named;
  else if (family === "research" && AI_RESEARCH_RE.test(title)) refined = "ml";
  if (OFF_TARGET_RE.test(title) && !SOFTWARE_TERM_RE.test(title) && !/\bIT\b/.test(title)) refined = "other";
  const out = INTERN_RE.test(title) || HIGH_SCHOOL_RE.test(title) || FELLOW_RE.test(title) || aboveEntryLevel(title);
  return { family: refined, isEntry: isEntry && !out };
}

function seniorityOf(title: string, isEntry: boolean): Seniority {
  if (!isEntry) return "other";
  return NEW_GRAD_RE.test(title) || LEVEL_ONE_RE.test(title) ? "new_grad" : "unleveled";
}

// Applies the rules to a stored label, so rule changes reach titles labelled before them.
// Community lists are curated new-grad roles, so a listed job is entry level unless its
// title says internship.
export function withRules(title: string, verdict: TitleVerdict, listed = false): TitleVerdict {
  const refined = refine(title, verdict.roleFamily, verdict.isEntry);
  const isEntry = listed ? !INTERN_RE.test(title) : refined.isEntry;
  const seniority = listed && isEntry ? "new_grad" : seniorityOf(title, isEntry);
  return { ...verdict, isEntry, roleFamily: refined.family, seniority, season: ruleSeason(title), degree: ruleDegree(title) };
}

// "Member of Technical Staff" is the plain engineer title at many AI labs, not a staff level.
const SENIOR_RE =
  /\b(senior|sr|staff|principal|lead|leads|manager|director|head|architect|distinguished|vp|vice president|chief|supervisor|mid[\s-]?level|experienced)\b/i;
// Level two and up: "Engineer II", "SDE 3", "Level 2", "L4" (Google-style L3 is the new-grad level).
const UPPER_LEVEL_RE = /\b(II|III|IV|V|VI)\b|\bL([4-9]|1\d)\b/;
const UPPER_LEVEL_CI_RE = /\b(engineer|developer|sde|swe|scientist|analyst|programmer|level)\s*[-–]?\s*([2-9]|ii|iii|iv)\b/i;
const EXPERIENCE_RE = /\b([3-9]|1\d)\s*\+?\s*(?:[-–]\s*\d+\s*)?(years?|yrs?)\b/i;
const HARDWARE_RE =
  /\b(hardware|asic|fpga|rtl|silicon|electrical|analog|physical design|design verification|pcba?|fire protection|field service|quality engineer)\b/i;
// Narrower than SOFTWARE_TERM_RE: "Mechanical Engineer, Robotics" is not stored.
const CANDIDATE_SOFTWARE_RE = /\b(software|sw|develop\w*|programming|machine learning|ml|ai|data (engineer|scien)\w*)\b/i;
// The title has to name an engineering job, not just mention a tech word ("AI Sales").
const TECH_ROLE_RE =
  /\b(engineers?|developers?|programmers?|sde|swe|scientists?|technical staff|data analysts?|devops|sre|(software|machine learning|data|ml|ai) engineering)\b/i;
const NON_ENGINEERING_RE =
  /\b(recruit\w*|sales|account executive|representative|marketing|counsel|attorney|partner|customer success|support|advocate|evangelist|writer)\b/i;

// True when the title names a level above entry, years of experience, or an internship.
export function aboveEntryLevel(title: string): boolean {
  const t = title.replace(/\bmember of (the )?technical staff\b/gi, "MTS");
  return SENIOR_RE.test(t) || UPPER_LEVEL_RE.test(t) || UPPER_LEVEL_CI_RE.test(t) || EXPERIENCE_RE.test(t);
}

// Only software, ML/AI, and data titles that are not internships or above entry level are
// stored; everything else on a board is skipped. Titles with no level ("Software Engineer")
// are kept, since some of them hire new grads.
export function isCandidateTitle(title: string): boolean {
  if (INTERN_RE.test(title) || aboveEntryLevel(title)) return false;
  if (!TECH_ROLE_RE.test(title) || NON_ENGINEERING_RE.test(title)) return false;
  if (CANDIDATE_SOFTWARE_RE.test(title)) return true;
  return !OFF_TARGET_RE.test(title) && !HARDWARE_RE.test(title);
}

// Start or graduation year: a title naming 2027 ("2027 Start", "Class of 2027", "'27")
// matches, one naming only other years ("New Grad 2026", "Class of 2028") does not, and
// one naming no year is unspecified.
export function ruleSeason(title: string): Season {
  const years = [...title.matchAll(/\b20(2[4-9]|30)\b|(?:'|’|\bfy\s?)(2[4-9]|30)\b/gi)].map((m) => m[1] ?? m[2]);
  if (years.length === 0) return "unspecified";
  return years.includes("27") ? "y2027" : "other";
}

export function ruleDegree(title: string): Degree {
  const lower = /\b(master'?s?|ms|m\.s\.|bs|b\.s\.|bachelor'?s?|undergrad\w*)\b/i.test(title);
  if (lower) return "any";
  if (/\b(ph\.?\s?d|doctoral)\b/i.test(title)) return "phd_only";
  if (/\bMBA\b/.test(title)) return "mba_only";
  return "any";
}

// Without a model, any title that refine() does not rule out counts as entry level.
export function ruleClassify(title: string): TitleVerdict {
  const { family, isEntry } = refine(title, FAMILIES.find(([re]) => re.test(title))?.[1] ?? "other", true);
  const seniority = seniorityOf(title, isEntry);
  const technical = TARGET_FAMILIES.includes(family);
  let score = 0.08;
  if (seniority === "new_grad" && technical) score = 0.9;
  else if (seniority === "unleveled" && technical) score = 0.6;
  else if (isEntry) score = 0.3;
  const reason = isEntry ? `${seniority === "new_grad" ? "new grad" : "no level"}, family ${family}` : "not entry level";
  return { isEntry, roleFamily: family, seniority, season: ruleSeason(title), degree: ruleDegree(title), score, reason, model: "rules" };
}

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const US_CODE_RE = new RegExp(`(,|^|\\s|-)\\s*(${US_STATE_CODES})(\\b|$)`);
// In titles a bare code is often a word ("AR Engineer", "Entra ID", "Engineer-CT"), so
// there a code counts only after a comma ("Issaquah, WA").
const US_CODE_AFTER_COMMA_RE = new RegExp(`,\\s*(${US_STATE_CODES})\\b`);
const PLACEHOLDER_RE = /^(n\/?a|null|none|tbd|-+)$/i;
const US_UPPER_RE = /\b(US|USA|U\.S\.A?\.?)\b/;
const US_WORD_RE =
  /\b(united states|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|nyc|san francisco|seattle|austin|boston|chicago|los angeles|san jose|palo alto|mountain view|menlo park|sunnyvale|santa clara|redmond|bellevue|denver|atlanta|miami|dallas|houston|pittsburgh|philadelphia|arlington|raleigh|san diego|irvine|minneapolis|detroit|salt lake city|honolulu)\b/i;
const NON_US_RE =
  /\b(canada|toronto|vancouver|montreal|ottawa|waterloo|calgary|mexico|brazil|s[aã]o paulo|london|united kingdom|uk|england|scotland|ireland|dublin|france|paris|germany|berlin|munich|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|switzerland|zurich|sweden|stockholm|poland|warsaw|krakow|india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|singapore|japan|tokyo|korea|seoul|china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|australia|sydney|melbourne|israel|tel aviv|uae|dubai|emea|apac|europe|latam|philippines|manila|vietnam|argentina|buenos aires|colombia|bogot[aá]|chile|costa rica|romania|bucharest|portugal|lisbon|denmark|copenhagen|norway|oslo|finland|helsinki|belgium|brussels|austria|vienna|czech|prague|hungary|budapest|greece|athens|turkey|istanbul|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|new zealand|auckland|iceland|reykjavik|luxembourg|guadalajara|monterrey|tijuana|shenyang|guangzhou|chengdu|hangzhou|nanjing|wuhan|suzhou|xiamen|dalian|tianjin|qingdao|xi'?an|hsinchu|osaka|kyoto|yokohama|busan|pangyo|clonmel|galway|cork|limerick|belfast|edinburgh|leeds|stoke[ -]on[ -]trent|eindhoven|rotterdam|utrecht|frankfurt|stuttgart|cologne|d[uü]sseldorf|erlangen|karlsruhe|lyon|toulouse|grenoble|lausanne|basel|gothenburg|malm[oö]|aarhus|espoo|tampere|turin|bologna|porto|leuven|ghent|antwerp|graz|brno|wroc[lł]aw|gda[nń]sk|cluj|ia[sș]i|sofia|bulgaria|belgrade|serbia|ukraine|kyiv|lviv|estonia|tallinn|lithuania|vilnius|latvia|riga|croatia|zagreb|slovakia|bratislava|slovenia|ljubljana|malaysia|kuala lumpur|penang|thailand|bangkok|indonesia|jakarta|pakistan|karachi|lahore|islamabad|bangladesh|dhaka|sri lanka|colombo|saudi|riyadh|qatar|doha|abu dhabi|morocco|uruguay|montevideo|ahmedabad|kolkata|kochi|coimbatore|jaipur|chandigarh|haifa|herzliya|jerusalem|quebec|edmonton|winnipeg|kitchener|mississauga|markham|burnaby|brisbane|adelaide|canberra|christchurch|cebu|hanoi|ho chi minh|da nang)\b/i;

// True if any listed place is in the US, false if every place is outside it, null if unclear.
// With fromTitle, a state code counts only after a comma (see US_CODE_AFTER_COMMA_RE).
export function ruleUs(location: string | null, fromTitle = false): boolean | null {
  if (!location?.trim()) return null;
  const parts = location
    .replace(/\bn\/a\b/gi, "")
    .split(/;|\||\/|\n| or /)
    .map((part) => part.trim())
    .filter((part) => part && !PLACEHOLDER_RE.test(part));
  const codeRe = fromTitle ? US_CODE_AFTER_COMMA_RE : US_CODE_RE;
  let allForeign = parts.length > 0;
  for (const part of parts) {
    // "Paris, TX" or "Dublin, OH, USA" is in the US even though the city name is also abroad.
    // ", CA" and ", IN" are skipped here because they also mean Canada and India ("Toronto, ON, CA",
    // "Pune, IN"), and a code followed by a country is not a state ("Chennai, TN, India").
    const comma = part.match(US_CODE_AFTER_COMMA_RE);
    const stateCode =
      comma && comma[1] !== "CA" && comma[1] !== "IN" && !NON_US_RE.test(part.slice(comma.index! + comma[0].length));
    if (US_UPPER_RE.test(part) || /united states/i.test(part) || stateCode) return true;
    const foreign = NON_US_RE.test(part);
    if (!foreign && (codeRe.test(part) || US_UPPER_RE.test(part) || US_WORD_RE.test(part))) return true;
    if (!foreign) allForeign = false;
  }
  return allForeign ? false : null;
}

export function evaluate(id: string, title: TitleVerdict, us: boolean | null): JobEvaluation {
  const misses: string[] = [];
  if (!title.isEntry) misses.push("not entry level");
  if (!TARGET_FAMILIES.includes(title.roleFamily)) misses.push(`family ${title.roleFamily}`);
  if (title.degree === "phd_only") misses.push("PhD only");
  if (title.degree === "mba_only") misses.push("MBA only");
  if (title.season === "other") misses.push("not a 2027 start");
  if (us === false) misses.push("outside the US");
  const match = misses.length === 0;
  return {
    id,
    isEntry: title.isEntry,
    roleFamily: title.roleFamily,
    seniority: title.seniority,
    season: title.season,
    degree: title.degree,
    us,
    match,
    score: match ? title.score : Math.min(title.score, 0.2),
    reason: (match ? title.reason : misses.join(", ")).slice(0, 240),
    model: title.model,
  };
}

// Season and degree are written in the title, so rules read them; the model only
// judges what the role is.
const TITLE_SYSTEM = `You label job titles for a 2027 graduate who wants a full-time, entry-level software, machine learning, AI, or data job.
For each numbered title return {"i": number, "entry": boolean, "family": string, "fit": number}:
- entry: true for a full-time role a new graduate can get: new grad, university or college graduate, early career, entry level, junior, associate, level I or 1, graduate programs, residencies, and plain titles that name no level ("Software Engineer, Payments"); false for internships, co-ops, high school programs, fellowships, postdocs, and roles above entry level (senior, staff, principal, lead, manager, director, architect, level II or higher, several years of experience)
- family, judged by the main daily work:
  swe: building software (backend, frontend, mobile, infrastructure, security engineering, compilers, GPU or math libraries, developer tools, forward deployed or solutions engineering that writes code)
  ml: machine learning, AI engineering (AI Engineer, Applied AI Engineer, LLM Engineer, GenAI Engineer), deep learning, data science, and AI research (computer vision, robotics learning, world models, simulation for AI, autonomous driving perception or planning)
  data: data engineering, analytics engineering, data analyst roles whose main work is data
  research: research outside AI (user research, physics, biology)
  hardware: chips, ASIC, physical design, electrical, computer architecture, systems hardware
  quant: quant research, trading, investment
  product: product management, program management
  design: product, UX, or visual design, illustration
  other: finance, risk, fraud, operations, people or HR analytics, audit, tax, sales, strategy, policy, and anything else
- fit: 0 to 1, how well it fits a new graduate looking for software, ML, AI, or data work
Reply with JSON only: {"results": [...]}`;

const LOCATION_SYSTEM = `For each numbered job location, decide whether the job can be done in the United States.
us: true if any listed place is in the US (including "Remote - US" or "Remote - Americas"), false if every place is outside the US, null if it cannot be told.
Reply with JSON only: {"results": [{"i": 1, "us": true}]}`;

function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
}

function resultsOf(data: unknown): Array<Record<string, unknown>> {
  const results = (data as { results?: unknown })?.results;
  return Array.isArray(results) ? (results.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>) : [];
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

async function llmTitles(titles: string[], providers: LlmProvider[]): Promise<Array<TitleVerdict | null>> {
  const out: Array<TitleVerdict | null> = titles.map(() => null);
  for (let start = 0; start < titles.length; start += 20) {
    const batch = titles.slice(start, start + 20);
    const answer = await askJson(providers, TITLE_SYSTEM, numbered(batch));
    if (!answer) break;
    for (const row of resultsOf(answer.data)) {
      const i = Number(row.i) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= batch.length || typeof row.entry !== "boolean") continue;
      const fit = typeof row.fit === "number" ? Math.min(1, Math.max(0, row.fit)) : 0.5;
      const { family, isEntry } = refine(batch[i], pick(ROLE_FAMILIES, row.family, "other"), row.entry);
      out[start + i] = {
        isEntry,
        roleFamily: family,
        seniority: seniorityOf(batch[i], isEntry),
        season: ruleSeason(batch[i]),
        degree: ruleDegree(batch[i]),
        score: fit,
        reason: isEntry ? `${family}, entry level` : `${family}, not entry level`,
        model: answer.model,
      };
    }
  }
  return out;
}

async function llmLocations(locations: string[], providers: LlmProvider[]): Promise<Array<LocationVerdict | null>> {
  const out: Array<LocationVerdict | null> = locations.map(() => null);
  for (let start = 0; start < locations.length; start += 40) {
    const batch = locations.slice(start, start + 40);
    const answer = await askJson(providers, LOCATION_SYSTEM, numbered(batch));
    if (!answer) break;
    for (const row of resultsOf(answer.data)) {
      const i = Number(row.i) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= batch.length) continue;
      const us = row.us === true ? true : row.us === false ? false : null;
      out[start + i] = { cacheKey: titleCacheKey(batch[i]), location: batch[i], us, model: answer.model };
    }
  }
  return out;
}

// Labels jobs that have not been judged yet (and re-judges rule-only ones once a model is
// available), then stores a match verdict per job. Returns how many jobs were evaluated.
export async function evaluateJobs(store: Store, limit: number, providersIn?: LlmProvider[]): Promise<number> {
  const providers = providersIn ?? (await llmProviders());
  const jobs: Job[] = await store.jobsNeedingEvaluation({ limit, upgradeRules: providers.length > 0 });
  if (jobs.length === 0) return 0;

  const titleByKey = new Map<string, string>();
  for (const job of jobs) if (job.titleKey && !titleByKey.has(job.titleKey)) titleByKey.set(job.titleKey, job.title);
  const titles = await store.getClassifications([...titleByKey.keys()]);
  const stale = [...titleByKey.keys()].filter((key) => {
    const hit = titles.get(key);
    return !hit || (hit.model === "rules" && providers.length > 0);
  });
  const budget = Math.max(0, envInt("CLASSIFY_BUDGET", 600));
  const asked = providers.length > 0 ? await llmTitles(stale.slice(0, budget).map((key) => titleByKey.get(key)!), providers) : [];
  const fresh: Classification[] = [];
  stale.forEach((key, i) => {
    const title = titleByKey.get(key)!;
    const verdict = asked[i] ?? (titles.has(key) ? null : ruleClassify(title));
    if (!verdict) return;
    const row = { ...verdict, cacheKey: key, title };
    titles.set(key, row);
    fresh.push(row);
  });
  await store.putClassifications(fresh);

  // Some boards put the city in the title ("... Intern (2027) - Lisbon, PT") and only
  // "In-Office" in the location, so the title is checked when the location is unclear.
  const usByRules = (job: Job) => ruleUs(job.location) ?? ruleUs(job.title, true);
  const unclear = new Map<string, string>();
  for (const job of jobs) {
    if (job.location && usByRules(job) === null) unclear.set(titleCacheKey(job.location), job.location);
  }
  const places = await store.getLocations([...unclear.keys()]);
  const unknown = [...unclear.keys()].filter((key) => !places.has(key));
  if (providers.length > 0 && unknown.length > 0) {
    const answers = (await llmLocations(unknown.map((key) => unclear.get(key)!), providers)).filter(
      (row): row is LocationVerdict => row !== null,
    );
    await store.putLocations(answers);
    for (const row of answers) places.set(row.cacheKey, row);
  }

  const rows: JobEvaluation[] = [];
  for (const job of jobs) {
    const title = titles.get(job.titleKey);
    if (!title) continue;
    const ruled = usByRules(job);
    const us = ruled ?? (job.location ? places.get(titleCacheKey(job.location))?.us ?? null : null);
    const listed = job.sourceUrls.some((source) => source.ats === "list");
    rows.push(evaluate(job.id, withRules(job.title, title, listed), us));
  }
  await store.saveEvaluations(rows);
  return rows.length;
}
