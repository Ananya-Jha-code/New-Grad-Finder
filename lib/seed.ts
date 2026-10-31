import type { Ats, Store, TargetInput } from "./types";
import { parseCsv } from "./csv";
import { targetIdFor } from "./targets";

export const STARTER_TARGETS: TargetInput[] = [
  { company: "Anthropic", ats: "greenhouse", boardToken: "anthropic" },
  { company: "Airbnb", ats: "greenhouse", boardToken: "airbnb" },
  { company: "Figma", ats: "greenhouse", boardToken: "figma" },
  { company: "Cloudflare", ats: "greenhouse", boardToken: "cloudflare" },
  { company: "Databricks", ats: "greenhouse", boardToken: "databricks" },
  { company: "Discord", ats: "greenhouse", boardToken: "discord" },
  { company: "Coinbase", ats: "greenhouse", boardToken: "coinbase" },
  { company: "Duolingo", ats: "greenhouse", boardToken: "duolingo" },
  { company: "Asana", ats: "greenhouse", boardToken: "asana" },
  { company: "Instacart", ats: "greenhouse", boardToken: "instacart" },
  { company: "Robinhood", ats: "greenhouse", boardToken: "robinhood" },
  { company: "Reddit", ats: "greenhouse", boardToken: "reddit" },
  { company: "Dropbox", ats: "greenhouse", boardToken: "dropbox" },
  { company: "Scale AI", ats: "greenhouse", boardToken: "scaleai" },
  { company: "Stripe", ats: "greenhouse", boardToken: "stripe" },
  { company: "Spotify", ats: "lever", boardToken: "spotify" },
  { company: "Palantir", ats: "lever", boardToken: "palantir" },
  {
    company: "NVIDIA",
    ats: "workday",
    workdayHost: "nvidia.wd5.myworkdayjobs.com",
    workdayTenant: "nvidia",
    workdaySite: "NVIDIAExternalCareerSite",
  },
];

export async function seedStarter(store: Store): Promise<number> {
  let added = 0;
  for (const input of STARTER_TARGETS) {
    if (await store.getTarget(targetIdFor(input))) continue;
    await store.upsertTarget(input);
    added++;
  }
  return added;
}

export async function importTargets(store: Store, csv: string): Promise<{ added: number; updated: number; errors: string[] }> {
  const rows = parseCsv(csv);
  if (rows.length === 0) return { added: 0, updated: 0, errors: ["csv is empty"] };
  const header = rows[0].map((cell) => cell.toLowerCase());
  const start = header[0] === "company" ? 1 : 0;
  let added = 0;
  let updated = 0;
  const errors: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const [company = "", ats = "", boardToken = "", workdayHost = "", workdayTenant = "", workdaySite = ""] = rows[i];
    const input: TargetInput = {
      company,
      ats: ats as Ats,
      boardToken: boardToken || null,
      workdayHost: workdayHost || null,
      workdayTenant: workdayTenant || null,
      workdaySite: workdaySite || null,
    };
    try {
      const existing = await store.getTarget(targetIdFor(input));
      await store.upsertTarget(input);
      if (existing) updated++;
      else added++;
    } catch (err) {
      errors.push(`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { added, updated, errors };
}
