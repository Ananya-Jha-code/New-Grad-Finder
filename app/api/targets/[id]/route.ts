import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be boolean" }, { status: 400 });
    await getStore().setTargetEnabled(decodeURIComponent(id), body.enabled);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not update board" }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await getStore().deleteTarget(decodeURIComponent(id));
  return Response.json({ ok: true });
}
