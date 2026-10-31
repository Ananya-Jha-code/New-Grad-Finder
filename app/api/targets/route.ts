import { getStore } from "@/lib/store";
import type { Ats } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      company?: string;
      ats?: Ats;
      boardToken?: string;
      workdayHost?: string;
      workdayTenant?: string;
      workdaySite?: string;
      intervalMinutes?: number;
    };
    if (!body.company || !body.ats) return Response.json({ error: "company and ats are required" }, { status: 400 });
    const target = await getStore().upsertTarget({
      company: body.company,
      ats: body.ats,
      boardToken: body.boardToken,
      workdayHost: body.workdayHost,
      workdayTenant: body.workdayTenant,
      workdaySite: body.workdaySite,
      intervalMinutes: body.intervalMinutes,
    });
    return Response.json(target);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not save board" }, { status: 400 });
  }
}
