import type { Job } from "./types";
import { sleep } from "./jitter";

// Discord shows at most 10 embeds per message, so a batch is split across messages
// rather than cut off; every match in the batch gets its own card.
const EMBEDS_PER_MESSAGE = 10;

const LEVEL_LABELS: Record<string, string> = { new_grad: "new grad", unleveled: "no level" };

function embed(job: Job) {
  return {
    title: job.title.slice(0, 250),
    url: job.canonicalUrl,
    description: [
      job.company,
      job.location,
      job.roleFamily,
      LEVEL_LABELS[job.seniority ?? ""] ?? null,
      job.season === "y2027" ? "2027 start" : null,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 300),
    color: 0x0e6b52,
  };
}

export async function notifyDiscord(jobs: Job[]): Promise<number> {
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook || jobs.length === 0) return 0;
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL is not a URL");
  }
  const hostOk = url.hostname === "discord.com" || url.hostname === "discordapp.com";
  if (url.protocol !== "https:" || !hostOk || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/ URL");
  }
  const parts = Math.ceil(jobs.length / EMBEDS_PER_MESSAGE);
  let sent = 0;
  for (let part = 0; part < parts; part++) {
    const batch = jobs.slice(part * EMBEDS_PER_MESSAGE, (part + 1) * EMBEDS_PER_MESSAGE);
    const heading = `${jobs.length} new grad match${jobs.length === 1 ? "" : "es"}.`;
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        username: "New Grad Finder",
        content: parts > 1 ? `${heading} (${part + 1}/${parts})` : heading,
        embeds: batch.map(embed),
      }),
    });
    if (!res.ok) throw new Error(`discord webhook returned ${res.status}`);
    sent += batch.length;
    // Webhooks allow about 5 messages per 2 seconds.
    if (part + 1 < parts) await sleep(700);
  }
  return sent;
}
