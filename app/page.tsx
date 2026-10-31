import { PollButton } from "@/components/PollButton";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

function when(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function HomePage() {
  const store = getStore();
  const [stats, jobs] = await Promise.all([
    store.stats(),
    store.listJobs({ matchOnly: true, limit: 8 }),
  ]);
  return (
    <main>
      <p className="lede">
        Polls public company job boards and three community new-grad lists. A match is a full-time, entry-level software, ML/AI, or data role in the US with a 2027 start (or no year named), open to bachelor&apos;s or master&apos;s graduates.
      </p>
      <section className="stats">
        <div className="stat"><b>{stats.targetsEnabled}</b><span>boards enabled of {stats.targets}</span></div>
        <div className="stat"><b>{stats.jobs}</b><span>roles saved</span></div>
        <div className="stat"><b>{stats.matches}</b><span>matches</span></div>
        <div className="stat"><b>{stats.applications}</b><span>applications tracked</span></div>
      </section>
      <PollButton label="Poll all boards" primary />
      <div className="split">
        <section className="table-wrap">
          {jobs.length === 0 ? (
            <div className="empty">No matches yet. Add boards, then poll one.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Score</th>
                  <th>Seen</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <a className="title-link" href={job.canonicalUrl} target="_blank" rel="noreferrer">{job.title}</a>
                      <span className="sub">{job.company}{job.location ? ` · ${job.location}` : ""} · {job.roleFamily}</span>
                    </td>
                    <td>{job.score === null ? "—" : Math.round(job.score * 100)}</td>
                    <td className="when">{when(job.firstSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="panel stack">
          <strong>Recent polls</strong>
          {stats.recentRuns.length === 0 ? <span className="sub">No polls yet.</span> : null}
          {stats.recentRuns.map((run) => (
            <span key={`${run.targetId}-${run.startedAt}`} className="sub">
              {when(run.finishedAt)} · {run.targetId} · {run.error ? run.error : `${run.jobsNew} new / ${run.jobsSeen} seen`}
            </span>
          ))}
        </section>
      </div>
    </main>
  );
}
