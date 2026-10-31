import { getStore } from "@/lib/store";
import type { ApplicationStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: string; status?: ApplicationStatus; notes?: string };
    if (!body.jobId) return Response.json({ error: "jobId is required" }, { status: 400 });
    const application = await getStore().upsertApplication({
      jobId: body.jobId,
      status: body.status,
      notes: body.notes,
    });
    return Response.json(application);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not save application" }, { status: 400 });
  }
}
