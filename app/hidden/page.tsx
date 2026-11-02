import { AppliedRow } from "@/components/AppliedRow";
import { postedTime, timeAgo } from "@/lib/posted";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function HiddenPage() {
  // listApplications is newest first by when the status last changed.
  const hidden = (await getStore().listApplications()).filter((item) => item.status === "hidden");
  return (
    <main>
      <p className="lede">
        Roles you hid from the Jobs page, most recently hidden first, with the reason you gave. Unhide a role to move it
        back to the Jobs page.
      </p>
      <div className="table-wrap">
        {hidden.length === 0 ? (
          <div className="empty">Nothing hidden. Use Hide on the Jobs page for roles you can&apos;t or won&apos;t apply to.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Posted</th>
                <th>Hidden</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hidden.map((item) => {
                const posted = postedTime(item);
                const marked = Date.parse(item.updatedAt);
                return (
                  <AppliedRow key={item.jobId} jobId={item.jobId} mode="hidden">
                    <td>
                      <a className="title-link" href={item.canonicalUrl} target="_blank" rel="noreferrer">{item.title}</a>
                      <span className="sub">{item.company}{item.location ? ` · ${item.location}` : ""}</span>
                    </td>
                    <td title={new Date(posted).toLocaleString()}>{timeAgo(posted)}</td>
                    <td title={new Date(marked).toLocaleString()}>{timeAgo(marked)}</td>
                    <td><span className="pill neutral">{item.notes || "—"}</span></td>
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
