import { TargetBoard } from "@/components/TargetBoard";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  const targets = await getStore().listTargets();
  return (
    <main>
      <p className="lede">
        Each board is one public careers endpoint. Greenhouse and Lever use the company token. Workday uses the host, tenant, and site from the careers URL. The poller waits a jittered gap between boards.
      </p>
      <TargetBoard targets={targets} />
    </main>
  );
}
