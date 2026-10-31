import { importTargets } from "@/lib/seed";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { csv?: string };
  if (!body.csv?.trim()) return Response.json({ error: "csv is required" }, { status: 400 });
  const result = await importTargets(getStore(), body.csv);
  return Response.json(result);
}
