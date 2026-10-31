import { getStore } from "@/lib/store";
import type { ApplicationStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const body = (await request.json()) as { status?: ApplicationStatus; notes?: string };
    const application = await getStore().upsertApplication({
      jobId: decodeURIComponent(jobId),
      status: body.status,
      notes: body.notes,
    });
    return Response.json(application);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not update application" }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  await getStore().deleteApplication(decodeURIComponent(jobId));
  return Response.json({ ok: true });
}
