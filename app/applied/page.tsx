import { AppliedRow } from "@/components/AppliedRow";
import { isApplied, postedTime, timeAgo } from "@/lib/posted";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function AppliedPage() {
  // listApplications is newest first by when the status last changed.
  const applied = (await getStore().listApplications()).filter((item) => isApplied(item.status));
  return (
    <main>
      <p className="lede">
        Roles you ticked as applied, most recent first. Open a posting to check on it, or untick Applied to move a role
        back to the Jobs page. Status and notes can be changed on the Applications page.
      </p>
      <div className="table-wrap">
        {applied.length === 0 ? (
          <div className="empty">Nothing here yet. Tick Applied on the Jobs page after you apply.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Posted</th>
                <th>Marked applied</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {applied.map((item) => {
                const posted = postedTime(item);
                const marked = Date.parse(item.updatedAt);
                return (
                  <AppliedRow key={item.jobId} jobId={item.jobId} applied>
                    <td>
                      <a className="title-link" href={item.canonicalUrl} target="_blank" rel="noreferrer">{item.title}</a>
                      <span className="sub">{item.company}{item.location ? ` · ${item.location}` : ""}</span>
                    </td>
                    <td title={new Date(posted).toLocaleString()}>{timeAgo(posted)}</td>
                    <td title={new Date(marked).toLocaleString()}>{timeAgo(marked)}</td>
                    <td><span className="pill neutral">{item.status}</span></td>
                  </AppliedRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
