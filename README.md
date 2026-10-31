# New Grad Finder

Watches thousands of company career boards (Greenhouse, Lever, Ashby, SmartRecruiters, Eightfold, Workday, Oracle, Amazon, TikTok) and three community new-grad lists for **full-time, entry-level software, ML/AI, and data roles in the US with a 2027 start**, open to bachelor's and master's graduates. New matches go to Discord, and a dashboard keeps the full list and an application tracker.

Adapted from [Job-Finder-Intern](https://github.com/ZERO34802/Job-Finder-Intern), which does the same for internships.

It runs on free tiers only: GitHub Actions polls, Supabase stores, Groq labels titles, Vercel hosts the dashboard.

```
cron-job.org (every 30 min) ──▶ GitHub Actions: npm run poll
                                   │  1. poll due boards + lists, add boards found in the lists
                                   │  2. keep entry-level tech titles, merge duplicates across sources
                                   │  3. label new titles (Groq, rules as fallback), decide match
                                   │  4. Discord alert for new matches
                                   ▼
                                Supabase (Postgres) ◀── Vercel dashboard (password protected)
```

## Sources

| Source | How | Notes |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | |
| Lever | `api.lever.co/v0/postings/{token}` | |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}` | |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | newest 200, plus new grad, graduate, early career searches |
| Eightfold | `{host}/api/apply/v2/jobs`, or the newer `{host}/api/pcsx/search` | Netflix, Qualcomm, PayPal, ...; Microsoft blocks non-browser clients, so it comes from the lists |
| Workday | public `wday/cxs` search: newest first, plus new grad, graduate, early career, entry level | slowest source |
| Oracle | `hcmRestApi/.../recruitingCEJobRequisitions` | newest 200, plus graduate and early career searches |
| Amazon | `amazon.jobs/en/search.json` | newest 200, plus early career, 2027, university graduate, jr |
| TikTok | `api.lifeattiktok.com` job search | "graduate" search (titles read "... Graduate - 2027 Start") |
| SimplifyJobs list | `listings.json` from `SimplifyJobs/New-Grad-Positions` | skips Hardware and Product categories and PhD/MBA-only listings |
| vanshb03 list | `listings.json` from `vanshb03/New-Grad-2027` | links are `go.vansh.nyc` short links, so they reveal no boards |
| speedyapply list | `NEW_GRAD_USA.md` from `speedyapply/2027-SWE-College-Jobs` | Markdown tables |

List postings older than 120 days are skipped; 2027 hiring opened in summer 2026, so older ones are mostly left over from the 2026 cycle. Every board link inside the lists is added as a board, which is how the board list grows; `npm run discover` (weekly in Actions) adds more from Hacker News "Who is hiring?" threads and Common Crawl. Only public endpoints are used: no logins, no LinkedIn, Indeed, or Handshake. A board that answers 404 or 422 is switched off. Boards with candidate postings are polled every run, quiet ones every 6 hours.

## What gets stored and what counts as a match

A board posting is stored only when its title names an engineering job (software, ML/AI, or data) and does not say intern or co-op, a senior level (senior, staff, lead, manager, ...), level II or higher, or 3+ years of experience. Plain titles with no level ("Software Engineer, Payments") are kept, since some of them hire new grads. List postings skip this check: the lists are curated new-grad roles.

A stored job matches when all of these hold:

- it is full-time and entry level (new grad, early career, level I, junior, associate, or no level named),
- the field is software, ML/AI (AI Engineer, LLM Engineer, and AI research count as ML), or data,
- the title names 2027 or no year at all (titles naming only 2026 or 2028 are left out),
- it is not PhD-only or MBA-only,
- no listed location is clearly outside the US (unknown locations are kept).

Whether a title is entry level and its field come from Groq (`openai/gpt-oss-120b`, then `qwen/qwen3.8-27b`, then `openai/gpt-oss-20b`, then a local Ollama model if one is running). Start year, degree, and clear locations come from rules, which also overrule the model in a few cases it gets wrong. Answers are cached per title and per location string. If no model is reachable, rules decide, and those jobs are re-labelled once a model is back; a rules-only match waits up to 2 hours for that before it alerts.

## Alerts

Discord only gets jobs that appear after a board is first polled. Postings already up when a board is added are stored as already announced, except ones posted in the last 48 hours. Each card shows the company, location, field, and level ("new grad" for an explicit new-grad title, "no level" for a plain one). The same posting found on a board and in a list is one row: jobs are matched by the ATS's own posting id from the URL, and list jobs also by company and title.

Companies that only post on LinkedIn are not covered; set a LinkedIn job alert (Past 24 hours, Entry level, United States) for those.

## Setup

1. **Supabase**: create a free project, paste [schema.sql](schema.sql) into the SQL editor, and run it. The file is safe to re-run after updates. Copy the project URL and the secret (service role) key.
2. **Discord**: channel settings, Integrations, Webhooks, New Webhook, copy the URL.
3. **Groq**: create a free API key at console.groq.com.
4. **GitHub**: push this repo (public, so Actions minutes are free) and add repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DISCORD_WEBHOOK_URL`, `GROQ_API_KEY`.
5. **Schedule**: GitHub's own cron in [.github/workflows/poll.yml](.github/workflows/poll.yml) often runs late or skips runs, so an outside cron starts the workflow. On cron-job.org, every 30 minutes, POST to `https://api.github.com/repos/<owner>/<repo>/actions/workflows/poll.yml/dispatches` with headers `Authorization: Bearer <fine-grained token with Actions read and write on this repo>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`, and body `{"ref":"main"}`. A 204 means it worked.
6. **Vercel**: import the repo and set `STORE=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DISCORD_WEBHOOK_URL`, and `APP_PASSWORD`. To let "Poll all boards" start a run, also set `GITHUB_DISPATCH_TOKEN` (the same kind of token as step 5) and `GITHUB_REPO=<owner>/<repo>`. Do not use Vercel's Supabase integration; it creates a separate database.

The first poll after setup only reads the three lists and adds the boards they link to; the run after that polls those boards for the first time.

## Run locally

```bash
npm install
cp .env.example .env    # fill in the values you have
npm test
npm run poll            # one cycle; add --force to ignore board intervals
npm run poll -- --target greenhouse:figma
npm run discover        # find more boards (Hacker News, Common Crawl)
npm run dev             # dashboard on http://127.0.0.1:3000
```

Without `STORE=supabase`, everything goes to a local SQLite file in `data/`. With `DISCORD_WEBHOOK_URL` set, a local poll sends real alerts. Every setting is described in [.env.example](.env.example). The [systemd/](systemd/) units run the poller on a Linux box instead of GitHub Actions.

## Free-tier limits this is built around

- **Supabase (500 MB)**: only entry-level tech titles are stored, `poll_runs` keeps runs with errors or new jobs for 7 days, and jobs no source has listed for 45 days are deleted unless you track them.
- **Groq**: per model, 1,000 requests a day and 8,000 tokens a minute; `qwen3.8-27b` also caps output at 1,000 tokens a minute. Titles go 20 per request, at most 600 new titles and 1,000 jobs per run, so a large backlog clears over several runs.
- **GitHub**: a run is limited to 40 minutes. Scheduled workflows stop after 60 days without repo activity; each scheduled poll re-enables the poll and discovery workflows through the API to prevent that.
- **Vercel**: the dashboard polls a single board in place; "Poll all boards" hands the full poll to GitHub Actions.
