import { seedStarter } from "@/lib/seed";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const added = await seedStarter(getStore());
  return Response.json({ added });
}
