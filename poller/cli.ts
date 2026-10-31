import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { crawlBoards, hnBoards } from "../lib/discover";
import { envFloat, envInt, jitteredMs, sleep } from "../lib/jitter";
import { pollTargets } from "../lib/poll";
import { seedStarter } from "../lib/seed";
import { getStore } from "../lib/store";

function loadEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function discover(): Promise<void> {
  const store = getStore();
  const fromHn = await hnBoards();
  console.log(`hacker news: ${fromHn.length} board links, ${await store.addTargets(fromHn)} new boards`);
  const crawl = await crawlBoards();
  console.log(`common crawl: ${crawl.boards.length} board links, ${await store.addTargets(crawl.boards)} new boards`);
  if (crawl.skipped.length > 0) console.log(`common crawl skipped (timeouts): ${crawl.skipped.join(", ")}`);
}

async function main(): Promise<void> {
  loadEnv();
  if (process.argv.includes("--discover")) {
    await discover();
    return;
  }
  if (process.argv.includes("--seed")) {
    const added = await seedStarter(getStore());
    console.log(`seeded ${added} new boards`);
    if (!process.argv.includes("--loop") && !arg("--target") && !process.argv.includes("--force")) return;
  }

  const once = async () => {
    const summary = await pollTargets({
      targetId: arg("--target"),
      force: process.argv.includes("--force") || Boolean(arg("--target")),
    });
    console.log(
      `polled ${summary.targets} boards, saw ${summary.jobsSeen}, candidate titles ${summary.candidates}, new ${summary.jobsNew}, new boards ${summary.discovered}, classified ${summary.classified}, alerted ${summary.alerted}`,
    );
    for (const error of summary.errors) console.error(`${error.targetId}: ${error.error}`);
  };

  if (process.argv.includes("--loop")) {
    for (;;) {
      await once();
      const wait = jitteredMs(envInt("POLL_INTERVAL_MINUTES", 360) * 60_000, envFloat("POLL_JITTER_RATIO", 0.2));
      console.log(`sleeping ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  await once();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
