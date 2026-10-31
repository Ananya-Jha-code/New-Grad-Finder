import { ApplicationTable } from "@/components/ApplicationTable";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const applications = await getStore().listApplications();
  return (
    <main>
      <p className="lede">Saved roles stay here after a board drops the posting. Status and notes are local unless you point the app at Supabase.</p>
      <ApplicationTable applications={applications} />
    </main>
  );
}
