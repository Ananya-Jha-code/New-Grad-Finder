import { dispatchPollWorkflow } from "@/lib/dispatch";
import { pollTargets } from "@/lib/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { targetId?: string };
    // One board is quick enough to poll here; all boards go to GitHub Actions.
    if (!body.targetId) {
      await dispatchPollWorkflow();
      return Response.json({ dispatched: true });
    }
    const summary = await pollTargets({ targetId: body.targetId, force: true });
    return Response.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "poll failed";
    const status = message === "A poll is already running" ? 409 : message.startsWith("Unknown target") ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
