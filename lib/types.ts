// "list" targets are community new-grad lists (board token names the feed).
// Eightfold targets use the careers site's host name as the board token. Oracle targets,
// like Workday ones, use the host/tenant/site fields. Amazon and TikTok are single boards.
export const ATS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "eightfold",
  "workday",
  "oracle",
  "amazon",
  "tiktok",
  "list",
] as const;
export type Ats = (typeof ATS)[number];

export const ROLE_FAMILIES = ["swe", "ml", "data", "research", "hardware", "quant", "product", "design", "other"] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];
// The families this search is for.
export const TARGET_FAMILIES: readonly RoleFamily[] = ["swe", "ml", "data"];

// Start year read from the title: 2027, no year given, or only some other year.
export const SEASONS = ["y2027", "unspecified", "other"] as const;
export type Season = (typeof SEASONS)[number];

export const DEGREES = ["any", "phd_only", "mba_only"] as const;
export type Degree = (typeof DEGREES)[number];

// new_grad: the title says new grad, early career, level I, ...; unleveled: an entry-level
// role whose title names no level; other: internships and roles above entry level.
export const SENIORITIES = ["new_grad", "unleveled", "other"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type SourceUrl = {
  ats: Ats;
  url: string;
  targetId: string;
};

export type Target = {
  id: string;
  company: string;
  ats: Ats;
  boardToken: string | null;
  workdayHost: string | null;
  workdayTenant: string | null;
  workdaySite: string | null;
  enabled: boolean;
  intervalMinutes: number;
  lastPolledAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  createdAt: string;
};

export type TargetInput = {
  company: string;
  ats: Ats;
  boardToken?: string | null;
  workdayHost?: string | null;
  workdayTenant?: string | null;
  workdaySite?: string | null;
  enabled?: boolean;
  intervalMinutes?: number;
};

export type JobDraft = {
  company: string;
  title: string;
  location: string | null;
  url: string;
  ats: Ats;
  targetId: string;
  externalId: string;
  postedAt: string | null;
  // Stored as already alerted: existing jobs on a board's first successful poll.
  quiet?: boolean;
  // List feeds format locations differently from boards, so their jobs also
  // match an existing job by company and title alone.
  looseMatch?: boolean;
};

export type Job = {
  id: string;
  canonicalUrl: string;
  title: string;
  company: string;
  location: string | null;
  ats: Ats;
  targetId: string | null;
  externalId: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceUrls: SourceUrl[];
  titleKey: string;
  isEntry: boolean | null;
  roleFamily: string | null;
  seniority: string | null;
  score: number | null;
  classifyReason: string | null;
  classifyModel: string | null;
  season: string | null;
  degree: string | null;
  us: boolean | null;
  match: boolean | null;
  alertedAt: string | null;
};

export type JobFilter = {
  q?: string;
  matchOnly?: boolean;
  family?: string;
  limit?: number;
};

export type Classification = {
  cacheKey: string;
  title: string;
  isEntry: boolean;
  roleFamily: RoleFamily;
  seniority: Seniority;
  season: Season;
  degree: Degree;
  score: number;
  reason: string;
  model: string;
};

// Whether a location string is in the US. Only model answers are cached; rules are recomputed.
export type LocationVerdict = {
  cacheKey: string;
  location: string;
  us: boolean | null;
  model: string;
};

export type JobEvaluation = {
  id: string;
  isEntry: boolean;
  roleFamily: RoleFamily;
  seniority: Seniority;
  season: Season;
  degree: Degree;
  us: boolean | null;
  match: boolean;
  score: number;
  reason: string;
  model: string;
};

export type Application = {
  jobId: string;
  status: ApplicationStatus;
  notes: string;
  updatedAt: string;
  title: string;
  company: string;
  canonicalUrl: string;
};

export type ApplicationInput = {
  jobId: string;
  status?: ApplicationStatus;
  notes?: string;
};

export type PollRun = {
  targetId: string;
  startedAt: string;
  finishedAt: string;
  jobsSeen: number;
  jobsNew: number;
  error: string | null;
};

export type Stats = {
  targets: number;
  targetsEnabled: number;
  jobs: number;
  matches: number;
  applications: number;
  recentRuns: PollRun[];
};

export interface Store {
  listTargets(): Promise<Target[]>;
  getTarget(id: string): Promise<Target | null>;
  upsertTarget(input: TargetInput): Promise<Target>;
  setTargetEnabled(id: string, enabled: boolean): Promise<void>;
  deleteTarget(id: string): Promise<void>;
  // Adds targets whose id is not stored yet; returns how many were added.
  addTargets(inputs: TargetInput[]): Promise<number>;
  touchTarget(id: string, status: string, error: string | null, intervalMinutes?: number): Promise<void>;
  upsertJobs(jobs: JobDraft[]): Promise<{ insertedIds: string[] }>;
  listJobs(filter: JobFilter): Promise<Job[]>;
  // Unevaluated jobs first; with upgradeRules, also jobs last judged by rules only.
  jobsNeedingEvaluation(opts: { limit: number; upgradeRules: boolean }): Promise<Job[]>;
  saveEvaluations(rows: JobEvaluation[]): Promise<void>;
  getClassifications(cacheKeys: string[]): Promise<Map<string, Classification>>;
  putClassifications(rows: Classification[]): Promise<void>;
  getLocations(cacheKeys: string[]): Promise<Map<string, LocationVerdict>>;
  putLocations(rows: LocationVerdict[]): Promise<void>;
  listUnalertedMatches(opts: { sinceHours: number; limit: number }): Promise<Job[]>;
  markAlerted(ids: string[]): Promise<void>;
  listApplications(): Promise<Application[]>;
  upsertApplication(input: ApplicationInput): Promise<Application>;
  deleteApplication(jobId: string): Promise<void>;
  recordRun(run: PollRun): Promise<void>;
  pruneRuns(olderThanDays: number): Promise<void>;
  // Deletes jobs no source has listed for this long, except tracked applications.
  pruneJobs(olderThanDays: number): Promise<number>;
  stats(): Promise<Stats>;
}
