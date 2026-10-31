import { evaluateJobs, isCandidateTitle } from "./classify";
import { notifyDiscord } from "./discord";
import { envInt, jitteredMs, sleep } from "./jitter";
import { SourceError } from "./http";
import { fetchList, fetchTargetJobs, LIST_FEEDS, type RemoteJob, toDrafts } from "./sources";
import { llmProviders } from "./llm";
import { getStore } from "./store";
import { isDue } from "./targets";
import type { Store, Target, TargetInput } from "./types";

export type PollSummary = {
  targets: number;
  jobsSeen: number;
  candidates: number;
  jobsNew: number;
  discovered: number;
  classified: number;
  alerted: number;
  errors: { targetId: string; error: string }[];
};

let inFlight: Promise<PollSummary> | null = null;

export function pollTargets(opts: { targetId?: string; force?: boolean } = {}): Promise<PollSummary> {
  if (inFlight) return Promise.reject(new Error("A poll is already running"));
  inFlight = runPoll(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const RECENT_POST_MS = 48 * 60 * 60 * 1000;

function postedRecently(postedAt: string | null): boolean {
  if (!postedAt) return false;
  const at = Date.parse(postedAt);
  return Number.isFinite(at) && Date.now() - at < RECENT_POST_MS;
}

// Boards on a shared API host (all Greenhouse boards hit one host) are split
// into a few sequential lanes; each Workday tenant is its own host and lane.
function hostKey(target: Target): string {
  if (target.ats === "workday" || target.ats === "oracle") return `${target.ats}:${target.workdayHost}`;
  // Each list and each Eightfold site is its own host.
  if (target.ats === "list" || target.ats === "eightfold") return `${target.ats}:${target.boardToken}`;
  return target.ats;
}

// Boards with candidate postings are checked every run; quiet ones every 6 hours.
// 25 rather than 30 so a slightly early cron run still counts the board as due.
const HOT_MINUTES = 25;
const QUIET_MINUTES = 360;

export function buildLanes(targets: Target[], lanesPerSharedHost: number): Target[][] {
  const groups = new Map<string, Target[]>();
  for (const target of targets) {
    const key = hostKey(target);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const lanes: Target[][] = [];
  for (const [key, group] of groups) {
    const count = key.includes(":") ? 1 : Math.max(1, Math.min(lanesPerSharedHost, group.length));
    const split: Target[][] = Array.from({ length: count }, () => []);
    group.forEach((target, i) => split[i % count].push(target));
    lanes.push(...split);
  }
  // Longest lanes start first so they are not left running alone at the end.
  return lanes.sort((a, b) => b.length - a.length);
}

async function runPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}

async function pollOne(store: Store, target: Target, summary: PollSummary, found: TargetInput[]): Promise<void> {
  summary.targets++;
  const startedAt = new Date().toISOString();
  try {
    let remote: RemoteJob[];
    if (target.ats === "list") {
      const list = await fetchList(target.boardToken ?? "");
      remote = list.jobs;
      found.push(...list.boards);
    } else {
      remote = await fetchTargetJobs(target);
    }
    const { drafts } = toDrafts(target, remote);
    // First successful poll of a board: existing openings are not news.
    const baseline = !target.lastOkAt;
    const list = target.ats === "list";
    // Lists are curated new-grad roles, so their titles skip the title filter.
    const candidates = drafts
      .filter((draft) => list || isCandidateTitle(draft.title))
      .map((draft) => ({ ...draft, quiet: baseline && !postedRecently(draft.postedAt), looseMatch: list }));
    const result = await store.upsertJobs(candidates);
    summary.jobsSeen += drafts.length;
    summary.candidates += candidates.length;
    summary.jobsNew += result.insertedIds.length;
    await store.touchTarget(target.id, "ok", null, list || candidates.length > 0 ? HOT_MINUTES : QUIET_MINUTES);
    // Only runs worth reading are kept; thousands of quiet boards per run would fill the free tier.
    if (result.insertedIds.length > 0) {
      await store.recordRun({
        targetId: target.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        jobsSeen: drafts.length,
        jobsNew: result.insertedIds.length,
        error: null,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push({ targetId: target.id, error: message });
    // Bookkeeping for a failed board must not stop the other boards from being polled.
    try {
      await store.touchTarget(target.id, "error", message.slice(0, 500), QUIET_MINUTES);
      // A board that is gone or a bad link guessed from a list (Workday answers 422) is switched off.
      if (err instanceof SourceError && (err.status === 404 || err.status === 422)) {
        await store.setTargetEnabled(target.id, false);
      }
      await store.recordRun({
        targetId: target.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        jobsSeen: 0,
        jobsNew: 0,
        error: message.slice(0, 500),
      });
    } catch (bookkeeping) {
      summary.errors.push({ targetId: target.id, error: `while recording the error: ${String(bookkeeping)}` });
    }
  }
}

async function runPoll(opts: { targetId?: string; force?: boolean }): Promise<PollSummary> {
  const store = getStore();
  const summary: PollSummary = {
    targets: 0,
    jobsSeen: 0,
    candidates: 0,
    jobsNew: 0,
    discovered: 0,
    classified: 0,
    alerted: 0,
    errors: [],
  };
  // Lists and the single-company career sites are always present as targets.
  await store.addTargets([
    ...Object.entries(LIST_FEEDS).map(([feed, config]) => ({ company: config.company, ats: "list" as const, boardToken: feed })),
    { company: "Amazon", ats: "amazon", boardToken: "amazon" },
    { company: "TikTok", ats: "tiktok", boardToken: "tiktok" },
  ]);
  const selected = opts.targetId ? [await store.getTarget(opts.targetId)] : await store.listTargets();
  const targets = selected.filter((target) => target !== null);
  if (opts.targetId && targets.length === 0) throw new Error(`Unknown target ${opts.targetId}`);

  const ready = targets.filter((target) => {
    if (opts.targetId) return true;
    return target.enabled && (opts.force || isDue(target));
  });
  // Discovery can add thousands of boards at once; only so many first polls fit in one
  // run, and the rest wait for the next runs.
  const firstPollCap = envInt("NEW_BOARDS_PER_RUN", 600);
  let firstPolls = 0;
  const due = ready.filter((target) => target.lastPolledAt || ++firstPolls <= firstPollCap);
  const gapMs = envInt("POLL_GAP_MS", 1200);
  const found: TargetInput[] = [];
  await runPool(buildLanes(due, envInt("POLL_HOST_LANES", 2)), envInt("POLL_CONCURRENCY", 16), async (lane) => {
    for (let i = 0; i < lane.length; i++) {
      if (i > 0) await sleep(jitteredMs(gapMs, 0.5));
      await pollOne(store, lane[i], summary, found);
    }
  });
  // A failure in any step below is recorded and the run moves on, so one bad request
  // cannot cost the run its alerts.
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      summary.errors.push({ targetId: name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // New boards are polled from the next run on, starting with a quiet baseline.
  if (found.length > 0) await step("discovery", async () => void (summary.discovered = await store.addTargets(found)));

  const providers = await llmProviders();
  await step("labelling", async () => void (summary.classified = await evaluateJobs(store, envInt("EVALUATE_LIMIT", 1000), providers)));

  if (process.env.DISCORD_WEBHOOK_URL?.trim()) {
    try {
      // A match judged by rules alone waits up to 2 hours for a model to confirm it.
      const holdMs = 2 * 60 * 60 * 1000;
      const matches = (await store.listUnalertedMatches({ sinceHours: 48, limit: 50 })).filter(
        (job) => providers.length === 0 || job.classifyModel !== "rules" || Date.now() - Date.parse(job.firstSeenAt) > holdMs,
      );
      if (matches.length > 0) {
        summary.alerted = await notifyDiscord(matches);
        await store.markAlerted(matches.map((job) => job.id));
      }
    } catch (err) {
      summary.errors.push({ targetId: "discord", error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    await store.pruneRuns(envInt("POLL_RUN_RETENTION_DAYS", 7));
    await store.pruneJobs(envInt("JOB_RETENTION_DAYS", 45));
  } catch (err) {
    summary.errors.push({ targetId: "prune", error: err instanceof Error ? err.message : String(err) });
  }

  return summary;
}
