// Starts the GitHub Actions poll. A full poll of thousands of boards takes minutes,
// longer than a Vercel function may run, so the dashboard hands it to Actions.
export async function dispatchPollWorkflow(): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  if (!token || !repo) throw new Error("Set GITHUB_DISPATCH_TOKEN and GITHUB_REPO to start a full poll from here");
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/poll.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "new-grad-finder",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error(`GitHub returned ${res.status} when starting the poll`);
}
