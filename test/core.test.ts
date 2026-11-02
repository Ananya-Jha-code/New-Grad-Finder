import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJobUrl, companyKey, dedupeKey, postingKey, titleCacheKey } from "../lib/canonicalize";
import { evaluate, evaluateJobs, withRules, isCandidateTitle, ruleClassify, ruleDegree, ruleSeason, ruleUs } from "../lib/classify";
import { parseCsv } from "../lib/csv";
import { notifyDiscord } from "../lib/discord";
import { isApplied, postedTime, timeAgo } from "../lib/posted";
import { jitteredMs } from "../lib/jitter";
import { buildLanes } from "../lib/poll";
import { boardFromUrl, LIST_FEEDS, LIST_MAX_AGE_DAYS, listedRecently, parseMarkdownListings, simplifyKeep } from "../lib/sources";
import { boardFromCrawlLine, boardsFromHnComment } from "../lib/discover";
import { importTargets, seedStarter } from "../lib/seed";
import { normalizeTarget } from "../lib/targets";
import { createSqliteStore } from "../lib/sqlite-store";
import type { Job, Target } from "../lib/types";

// Keep tests off the network: no Groq key, and an Ollama URL nothing listens on.
delete process.env.GROQ_API_KEY;
process.env.OLLAMA_URL = "http://127.0.0.1:9";

test("canonical urls drop tracking params, locale, and www", () => {
  const url = canonicalJobUrl(
    "http://www.NVIDIA.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Santa-Clara/Software-Intern_JR1/?utm_source=x&gh_jid=12",
  );
  assert.equal(
    url,
    "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Santa-Clara/Software-Intern_JR1?gh_jid=12",
  );
});

test("company and title keys collapse punctuation", () => {
  assert.equal(companyKey("Stripe, Inc."), "stripe");
  assert.equal(titleCacheKey("Software  Engineering Intern!"), "software engineering intern");
  assert.equal(
    dedupeKey("Stripe, Inc.", "Software Engineering Intern", "Remote"),
    dedupeKey("stripe", "software engineering intern", "remote"),
  );
});

test("jitter stays inside the requested band", () => {
  for (let i = 0; i < 50; i++) {
    const value = jitteredMs(1000, 0.2);
    assert.ok(value >= 800 && value <= 1200, String(value));
  }
  assert.equal(jitteredMs(1000, 0), 1000);
});

test("rules sort new-grad titles and leave interns and senior roles out", () => {
  const grad = ruleClassify("Software Development Engineer, Early Career - 2027 (US)");
  assert.equal(grad.isEntry, true);
  assert.equal(grad.roleFamily, "swe");
  assert.equal(grad.seniority, "new_grad");
  assert.ok(grad.score >= 0.85);
  assert.equal(ruleClassify("Machine Learning Engineer - College Graduate").roleFamily, "ml");
  assert.equal(ruleClassify("Data Scientist, Class of 2027").roleFamily, "ml");
  assert.equal(ruleClassify("Junior Data Engineer").roleFamily, "data");
  assert.equal(ruleClassify("Software Development Engineer I, Annapurna Labs").seniority, "new_grad");
  assert.equal(ruleClassify("Software Engineer, L3").seniority, "new_grad");
  const plain = ruleClassify("Software Engineer, Observability");
  assert.equal(plain.isEntry, true);
  assert.equal(plain.seniority, "unleveled");
  for (const title of ["Applied AI Engineer", "AI Engineer - FDE (Forward Deployed Engineer)", "LLM Engineer", "GenAI Engineer"]) {
    assert.equal(ruleClassify(title).roleFamily, "ml", title);
  }
  for (const title of [
    "Software Engineering Intern",
    "Machine Learning Co-op",
    "Senior Staff Engineer",
    "Software Engineer II",
    "Software Engineer (5+ years)",
    "Engineering Manager, Payments",
  ]) {
    const verdict = ruleClassify(title);
    assert.equal(verdict.isEntry, false, title);
    assert.equal(verdict.seniority, "other", title);
    assert.ok(verdict.score < 0.2, title);
  }
  assert.equal(ruleClassify("Internal Tools Engineer").isEntry, true);
});

test("csv parser keeps quoted commas", () => {
  const rows = parseCsv('company,ats\n"Stripe, Inc.",greenhouse\n');
  assert.deepEqual(rows, [
    ["company", "ats"],
    ["Stripe, Inc.", "greenhouse"],
  ]);
});

test("sqlite dedupes the same role across urls and caches a classification", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "new-grad-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const added = await seedStarter(store);
  assert.ok(added >= 18);
  assert.equal(await seedStarter(store), 0);

  const target = await store.getTarget("greenhouse:stripe");
  assert.ok(target);
  const first = await store.upsertJobs([
    {
      company: "Stripe, Inc.",
      title: "Software Engineer, New Grad",
      location: "Remote",
      url: "https://stripe.com/jobs/search?gh_jid=1&utm_source=board",
      ats: "greenhouse",
      targetId: target.id,
      externalId: "1",
      postedAt: null,
    },
  ]);
  const second = await store.upsertJobs([
    {
      company: "stripe",
      title: "Software Engineer, New Grad",
      location: "Remote",
      url: "https://jobs.lever.co/stripe/abc",
      ats: "lever",
      targetId: "lever:stripe",
      externalId: "abc",
      postedAt: null,
    },
  ]);
  assert.equal(first.insertedIds.length, 1);
  assert.equal(second.insertedIds.length, 0);
  const jobs = await store.listJobs({ q: "Software Engineer" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrls.length, 2);
  assert.match(jobs[0].canonicalUrl, /gh_jid=1$/);

  assert.equal(await evaluateJobs(store, 100, []), 1);
  const classified = await store.listJobs({ matchOnly: true, limit: 10 });
  assert.equal(classified.length, 1);
  assert.equal(classified[0].isEntry, true);
  assert.equal(classified[0].us, null);
  assert.equal(classified[0].classifyModel, "rules");
  assert.equal(await evaluateJobs(store, 100, []), 0);

  const app = await store.upsertApplication({ jobId: classified[0].id, status: "applied", notes: "referral" });
  assert.equal(app.status, "applied");
  assert.equal((await store.listApplications()).length, 1);

  const imported = await importTargets(store, "company,ats,board_token\nNot A Board,greenhouse,bad token\nLinear,greenhouse,linear\n");
  assert.equal(imported.added, 1);
  assert.equal(imported.errors.length, 1);
  assert.ok(await store.getTarget("greenhouse:linear"));
});

test("entry-level and no-level tech titles are kept as candidates", () => {
  const kept = [
    "Software Engineer, New Grad",
    "Software Engineer - Platform - Early Career",
    "Java Software Developer - entry level",
    "Software Development Engineer I",
    "SDE I, Amazon Ads",
    "Innovation Software Engineer 1 - Marketplace",
    "Associate Software Engineer",
    "Junior Data Engineer",
    "Machine Learning Engineer, University Graduate 2027",
    "Applied AI Engineer",
    "Member of Technical Staff",
    "Data Scientist, Class of 2027",
    "Software Engineer",
    "Internal Tools Engineer",
    "Software Engineer, Hardware Tools and Methodology (Master's)",
    "Software Engineer, L3",
  ];
  for (const title of kept) assert.equal(isCandidateTitle(title), true, title);
  const dropped = [
    "Software Engineer Intern, Summer 2027",
    "Machine Learning Co-op",
    "NVIDIA 2027 Internships: Software Engineering",
    "Senior Software Engineer",
    "Sr. Data Scientist",
    "Staff Machine Learning Engineer",
    "Engineering Manager, Payments",
    "Tech Lead, Search",
    "Principal Architect",
    "Software Engineer II",
    "Software Development Engineer III",
    "Software Engineer 2",
    "Software Engineer (5+ years)",
    "Software Engineer, L4",
    "ASIC Design Verification Engineer (Master's)",
    "Mechanical Engineer I",
    "Mechanical Engineer, PCBA Test Infrastructure, Robotics",
    "Electrical Engineer, Robotics",
    "Fire Protection Engineer",
    "Account Executive",
    "Account Executive, AI Sales",
    "Technical Recruiter | Engineering",
    "Developer Engagement Representative - LATAM (Part-Time Contract)",
    "AI Transformation Leader",
    "Registered Nurse - New Grad",
  ];
  for (const title of dropped) assert.equal(isCandidateTitle(title), false, title);
});

test("lanes split shared hosts and keep each workday tenant alone", () => {
  const make = (id: string, ats: Target["ats"], workdayHost: string | null = null): Target => ({
    id,
    company: id,
    ats,
    boardToken: ats === "workday" ? null : id,
    workdayHost,
    workdayTenant: null,
    workdaySite: null,
    enabled: true,
    intervalMinutes: 360,
    lastPolledAt: null,
    lastStatus: null,
    lastError: null,
    lastOkAt: null,
    createdAt: "",
  });
  const lanes = buildLanes(
    [
      make("a", "greenhouse"),
      make("b", "greenhouse"),
      make("c", "greenhouse"),
      make("d", "lever"),
      make("e", "workday", "e.wd5.myworkdayjobs.com"),
      make("f", "workday", "f.wd1.myworkdayjobs.com"),
    ],
    2,
  );
  assert.equal(lanes.length, 5);
  assert.deepEqual(lanes.map((lane) => lane.map((t) => t.id).join("")).sort(), ["ac", "b", "d", "e", "f"]);
});

test("quiet drafts are stored as already alerted and a good poll sets last_ok_at", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "new-grad-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  await seedStarter(store);
  const draft = {
    company: "Figma",
    title: "Software Engineer, New Grad",
    location: "San Francisco, CA",
    url: "https://boards.greenhouse.io/figma/jobs/1",
    ats: "greenhouse" as const,
    targetId: "greenhouse:figma",
    externalId: "1",
    postedAt: null,
  };
  await store.upsertJobs([{ ...draft, quiet: true }, { ...draft, title: "ML Engineer", url: "https://boards.greenhouse.io/figma/jobs/2" }]);
  await evaluateJobs(store, 100, []);
  const matches = await store.listUnalertedMatches({ sinceHours: 1, limit: 10 });
  assert.deepEqual(matches.map((job) => job.title), ["ML Engineer"]);

  const cached = await store.getClassifications(["ml engineer", "missing"]);
  assert.equal(cached.size, 1);
  assert.equal(cached.get("ml engineer")?.roleFamily, "ml");

  assert.equal((await store.getTarget("greenhouse:figma"))?.lastOkAt, null);
  await store.touchTarget("greenhouse:figma", "error", "boom");
  assert.equal((await store.getTarget("greenhouse:figma"))?.lastOkAt, null);
  await store.touchTarget("greenhouse:figma", "ok", null);
  assert.ok((await store.getTarget("greenhouse:figma"))?.lastOkAt);
});

test("start year and degree come from the title", () => {
  assert.equal(ruleSeason("Software Development Engineer, Early Career - 2027 (US)"), "y2027");
  assert.equal(ruleSeason("Machine Learning Engineer Graduate (TikTok-Data-Search-Search Quality) - 2027 Start"), "y2027");
  assert.equal(ruleSeason("[2027] Software Engineer, Early Career"), "y2027");
  assert.equal(ruleSeason("2027 Software Engineer Program - Full-Time - United States - February Start"), "y2027");
  assert.equal(ruleSeason("Research Scientist - New College Grad 2027"), "y2027");
  assert.equal(ruleSeason("Data Scientist, Class of 2027"), "y2027");
  assert.equal(ruleSeason("Software Engineer, New Grad (Dec 2026 - Jun 2027 graduates)"), "y2027");
  assert.equal(ruleSeason("Software Engineer, New Grad '27"), "y2027");
  assert.equal(ruleSeason("Security Architect - New College Grad 2026"), "other");
  assert.equal(ruleSeason("Research Scientist Graduate (TikTok Recommendation-Agentic AI) - 2026 Start (PhD)"), "other");
  assert.equal(ruleSeason("Software Engineer, Class of 2028"), "other");
  assert.equal(ruleSeason("Software Engineer, New Grad"), "unspecified");
  assert.equal(ruleSeason("DFT Engineer - New College Grad"), "unspecified");
  assert.equal(ruleDegree("Research Scientist Graduate - 2027 Start (PhD)"), "phd_only");
  assert.equal(ruleDegree("RTL Power Optimization Engineer (Master's)"), "any");
  assert.equal(ruleDegree("Research Scientist, New Grad (MS/PhD)"), "any");
  assert.equal(ruleDegree("Category Manager Graduate - 2027 Start (MBA)"), "mba_only");
});

test("locations sort into US, abroad, and unclear", () => {
  assert.equal(ruleUs("Hybrid - San Francisco, CA"), true);
  assert.equal(ruleUs("New York, NY"), true);
  assert.equal(ruleUs("Washington, D.C."), true);
  assert.equal(ruleUs("Remote-US"), true);
  assert.equal(ruleUs("Mountain View, California; San Francisco, California"), true);
  assert.equal(ruleUs("NYC / Toronto"), true);
  assert.equal(ruleUs("Bengaluru"), false);
  assert.equal(ruleUs("London, United Kingdom"), false);
  assert.equal(ruleUs("Seoul, South Korea"), false);
  assert.equal(ruleUs("Toronto, ON"), false);
  assert.equal(ruleUs("Remote - Americas"), null);
  assert.equal(ruleUs("2 Locations"), null);
  assert.equal(ruleUs(null), null);
  assert.equal(ruleUs("Product Manager Intern (2027) - Lisbon, PT"), false);
  assert.equal(ruleUs("Product Manager Intern (2027) - London, UK"), false);
  assert.equal(ruleUs("Software Engineer Intern (2027) - Austin, TX"), true);
  assert.equal(ruleUs("Software Engineer, Intern"), null);
});

test("a match needs entry level, target family, a 2027 or unnamed start, degree, and the US", () => {
  const swe = ruleClassify("Software Engineer, New Grad");
  assert.equal(evaluate("a", swe, true).match, true);
  assert.equal(evaluate("a", swe, null).match, true);
  const abroad = evaluate("a", swe, false);
  assert.equal(abroad.match, false);
  assert.equal(abroad.reason, "outside the US");
  assert.ok(abroad.score <= 0.2);
  assert.equal(evaluate("a", ruleClassify("Software Engineer, Payments"), true).match, true);
  assert.equal(evaluate("a", ruleClassify("Junior Data Engineer"), true).match, true);
  assert.equal(evaluate("a", ruleClassify("Software Engineer Intern"), true).reason, "not entry level");
  assert.equal(evaluate("a", ruleClassify("Security Architect - New College Grad 2026"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("Software Engineer, New Grad 2026"), true).reason, "not a 2027 start");
  assert.equal(evaluate("a", ruleClassify("Machine Learning Engineer Graduate - 2027 Start (PhD)"), true).reason, "PhD only");
  assert.equal(evaluate("a", ruleClassify("Hardware Engineer, New Grad"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("Senior Software Engineer"), true).match, false);
});

test("rules override stored labels for off-target engineering, fellowships, and list jobs", () => {
  const label = (title: string, listed = false) =>
    withRules(title, { ...ruleClassify("Software Engineer, New Grad"), roleFamily: "swe" }, listed);
  assert.equal(label("Civil Engineer, New Grad 2027").roleFamily, "other");
  assert.equal(label("GIS Analyst I").roleFamily, "other");
  assert.equal(label("GIS Software Developer, Early Career").roleFamily, "swe");
  assert.equal(label("Embedded Firmware and Controls Engineer I").roleFamily, "swe");
  assert.equal(label("AI Engineer, Early Career").roleFamily, "ml");
  assert.equal(label("Research Fellow in Surgical AI").isEntry, false);
  assert.equal(label("Senior Software Engineer").isEntry, false);
  // List jobs are curated new-grad roles, so a plain or odd title still counts.
  const listed = label("Security Architect", true);
  assert.equal(listed.isEntry, true);
  assert.equal(listed.seniority, "new_grad");
  assert.equal(label("Software Engineer Intern", true).isEntry, false);
});

test("posting keys line up a list link with its board posting", () => {
  assert.equal(postingKey("https://job-boards.greenhouse.io/scaleai/jobs/4567?utm_source=Simplify"), "gh:4567");
  assert.equal(postingKey("https://scale.com/careers?gh_jid=4567"), "gh:4567");
  assert.equal(
    postingKey("https://jobs.lever.co/palantir/1b2c3d4e-0000-4000-8000-123456789abc/apply"),
    "lever:1b2c3d4e-0000-4000-8000-123456789abc",
  );
  assert.equal(
    postingKey("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern_JR2001234"),
    "wd:nvidia:jr2001234",
  );
  assert.equal(postingKey("https://jobs.smartrecruiters.com/BoschGroup/744000158594769"), "sr:744000158594769");
  assert.equal(postingKey("https://explore.jobs.netflix.net/careers/job/790318904468"), "ef:790318904468");
  assert.equal(postingKey("https://hcwp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2010917"), "or:hcwp:2010917");
  assert.equal(postingKey("https://www.amazon.jobs/jobs/10587999/apply"), "amzn:10587999");
  assert.equal(postingKey("https://amazon.jobs/en/jobs/10587999/sde-intern"), "amzn:10587999");
  assert.equal(postingKey("https://lifeattiktok.com/search/7610545287514392837"), "tt:7610545287514392837");
  assert.equal(postingKey("https://go.vansh.nyc/Zo"), null);
});

test("board links in a list become targets", () => {
  assert.deepEqual(boardFromUrl("Scale AI", "https://job-boards.greenhouse.io/scaleai/jobs/4567"), {
    company: "Scale AI",
    ats: "greenhouse",
    boardToken: "scaleai",
  });
  assert.equal(boardFromUrl("X", "https://boards.greenhouse.io/embed/job_app?for=figma&token=1")?.boardToken, "figma");
  assert.equal(boardFromUrl("Ramp", "https://jobs.ashbyhq.com/ramp/abc")?.ats, "ashby");
  assert.deepEqual(boardFromUrl("NVIDIA", "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x_JR1"), {
    company: "NVIDIA",
    ats: "workday",
    workdayHost: "nvidia.wd5.myworkdayjobs.com",
    workdayTenant: "nvidia",
    workdaySite: "NVIDIAExternalCareerSite",
  });
  assert.equal(boardFromUrl("Acme", "https://acme.com/careers/123"), null);
  assert.deepEqual(boardFromUrl("Waymo", "https://careers.withwaymo.com/jobs?gh_jid=8234553"), {
    company: "Waymo",
    ats: "greenhouse",
    boardToken: "waymo",
  });
  assert.deepEqual(boardFromUrl("Texas Instruments", "https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123"), {
    company: "Texas Instruments",
    ats: "oracle",
    workdayHost: "edbz.fa.us2.oraclecloud.com",
    workdaySite: "CX",
  });
  assert.deepEqual(boardFromUrl("Netflix", "https://explore.jobs.netflix.net/careers/job/790318904468"), {
    company: "Netflix",
    ats: "eightfold",
    boardToken: "explore.jobs.netflix.net",
  });
  assert.equal(boardFromUrl("Qualcomm", "https://qualcomm.eightfold.ai/careers?pid=446721064018")?.boardToken, "qualcomm.eightfold.ai");
});

test("a list job and its board posting become one row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "new-grad-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  assert.equal(await store.addTargets([{ company: "SimplifyJobs list", ats: "list", boardToken: "simplify" }]), 1);
  assert.equal(await store.addTargets([{ company: "SimplifyJobs list", ats: "list", boardToken: "simplify" }]), 0);
  const fromList = await store.upsertJobs([
    {
      company: "Scale AI",
      title: "Software Engineering Intern (Summer 2027)",
      location: "SF",
      url: "https://job-boards.greenhouse.io/scaleai/jobs/4567?utm_source=Simplify&ref=Simplify",
      ats: "list",
      targetId: "list:simplify",
      externalId: "x",
      postedAt: null,
      looseMatch: true,
    },
  ]);
  const fromBoard = await store.upsertJobs([
    {
      company: "Scale AI",
      title: "Software Engineering Intern (Summer 2027)",
      location: "San Francisco, CA",
      url: "https://scale.com/careers/4567?gh_jid=4567",
      ats: "greenhouse",
      targetId: "greenhouse:scaleai",
      externalId: "4567",
      postedAt: null,
    },
  ]);
  const fromOtherList = await store.upsertJobs([
    {
      company: "Scale AI, Inc.",
      title: "Software Engineering Intern (Summer 2027)",
      location: "San Francisco",
      url: "https://go.vansh.nyc/abc",
      ats: "list",
      targetId: "list:vansh",
      externalId: "y",
      postedAt: null,
      looseMatch: true,
    },
  ]);
  assert.equal(fromList.insertedIds.length, 1);
  assert.equal(fromBoard.insertedIds.length, 0);
  assert.equal(fromOtherList.insertedIds.length, 0);
  const jobs = await store.listJobs({ q: "Scale" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrls.length, 3);
});

test("old jobs are pruned unless they are tracked", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "new-grad-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const draft = (n: number) => ({
    company: "Acme",
    title: `Software Engineer Intern ${n}`,
    location: "Austin, TX",
    url: `https://boards.greenhouse.io/acme/jobs/${n}`,
    ats: "greenhouse" as const,
    targetId: "greenhouse:acme",
    externalId: String(n),
    postedAt: null,
  });
  const { insertedIds } = await store.upsertJobs([draft(1), draft(2), draft(3)]);
  await store.upsertApplication({ jobId: insertedIds[0], status: "applied" });
  assert.equal(await store.pruneJobs(1), 0);
  assert.equal(await store.pruneJobs(-1), 2);
  const left = await store.listJobs({ limit: 10 });
  assert.deepEqual(left.map((job) => job.id), [insertedIds[0]]);
});

test("speedyapply markdown tables parse by header name", () => {
  const md = [
    "### FAANG+",
    "",
    "| Company | Position | Location | Salary | Posting | Age |",
    "|---|---|---|---|---|---|",
    '| <a href="https://www.amazon.com"><strong>Amazon</strong></a> | SDE Intern - Summer 2027 | Redmond, WA | $53/hr | <a href="https://www.amazon.jobs/jobs/10587999/apply"><img alt="Apply"/></a> | 6d |',
    "",
    "### Other",
    "",
    "| Company | Position | Location | Posting | Age |",
    "|---|---|---|---|---|",
    '| <a href="https://x.com"><strong>Rivian</strong></a> | Software Engineering Intern | Irvine, CA +1 | <a href="https://jobs.ashbyhq.com/rivianvw.tech/f5aa59d9-4fdc-42d5-931d-efd9e6d96f2f"><img alt="Apply"/></a> | 51d |',
  ].join("\n");
  const now = Date.UTC(2026, 9, 29);
  const items = parseMarkdownListings(md, now);
  assert.equal(items.length, 2);
  assert.equal(items[0].company_name, "Amazon");
  assert.equal(items[0].title, "SDE Intern - Summer 2027");
  assert.equal(items[0].url, "https://www.amazon.jobs/jobs/10587999/apply");
  assert.deepEqual(items[0].locations, ["Redmond, WA"]);
  assert.equal(items[0].date_posted, Math.floor((now - 6 * 86_400_000) / 1000));
  assert.equal(items[1].company_name, "Rivian");
  assert.equal(items[1].locations?.[0], "Irvine, CA +1");
});

test("new-grad lists drop stale, hardware, product, and PhD/MBA-only listings", () => {
  const now = Date.UTC(2026, 9, 31);
  const daysAgo = (days: number) => Math.floor((now - days * 86_400_000) / 1000);
  const listing = { title: "Software Engineer, New Grad", category: "Software", degrees: ["Bachelor's"], date_posted: daysAgo(3) };
  assert.equal(simplifyKeep(listing, now), true);
  assert.equal(simplifyKeep({ ...listing, category: "AI/ML/Data" }, now), true);
  assert.equal(simplifyKeep({ ...listing, category: "Quant" }, now), true);
  assert.equal(simplifyKeep({ ...listing, category: "Hardware" }, now), false);
  assert.equal(simplifyKeep({ ...listing, category: "Product" }, now), false);
  assert.equal(simplifyKeep({ ...listing, degrees: ["PhD"] }, now), false);
  assert.equal(simplifyKeep({ ...listing, degrees: ["MBA", "PhD"] }, now), false);
  assert.equal(simplifyKeep({ ...listing, degrees: ["Master's", "PhD"] }, now), true);
  assert.equal(simplifyKeep({ ...listing, degrees: [] }, now), true);
  assert.equal(simplifyKeep({ ...listing, date_posted: daysAgo(LIST_MAX_AGE_DAYS + 1) }, now), false);
  assert.equal(listedRecently({ date_posted: daysAgo(LIST_MAX_AGE_DAYS - 1) }, now), true);
  assert.equal(listedRecently({}, now), true);
  for (const feed of Object.values(LIST_FEEDS)) assert.doesNotMatch(feed.url, /intern/i);
});

test("discovered Oracle boards normalize to one id per host and site", () => {
  const target = normalizeTarget({ company: "TI", ats: "oracle", workdayHost: "edbz.fa.us2.oraclecloud.com", workdaySite: "CX" });
  assert.equal(target.id, "oracle:edbz-cx");
  assert.equal(target.workdayTenant, "edbz-cx");
  assert.throws(() => normalizeTarget({ company: "X", ats: "oracle", workdayHost: "evil.example.com", workdaySite: "CX" }));
});

test("HN hiring posts and crawl lines yield startup boards", () => {
  const comment =
    "Acme Robotics | Software Engineer Intern | SF<p>Apply: <a href=\"https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme-robotics&#x2F;123\">https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme-robotics&#x2F;123</a>" +
    " or https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;embed&#x2F;job_app?for=acmeco";
  const boards = boardsFromHnComment(comment);
  assert.deepEqual(boards[0], { company: "Acme Robotics", ats: "ashby", boardToken: "acme-robotics" });
  assert.deepEqual(boards.find((b) => b.ats === "greenhouse"), { company: "Acme Robotics", ats: "greenhouse", boardToken: "acmeco" });
  assert.deepEqual(boardFromCrawlLine('{"url": "https://jobs.lever.co/zipline/abc-123"}'), {
    company: "zipline",
    ats: "lever",
    boardToken: "zipline",
  });
  assert.equal(boardFromCrawlLine('{"url": "https://boards.greenhouse.io/embed/job_board"}'), null);
  assert.equal(boardFromCrawlLine("not json"), null);
});

test("discord alerts say new grad and split into messages of 10 cards", async (t) => {
  const bodies: Array<{ username: string; content: string; embeds: Array<{ description: string }> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  const previous = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/test";
  try {
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      title: `Software Engineer, New Grad ${i}`,
      canonicalUrl: `https://example.com/${i}`,
      company: "Stripe",
      location: "Seattle, WA",
      roleFamily: "swe",
      seniority: i === 0 ? "new_grad" : "unleveled",
      season: "y2027",
    })) as unknown as Job[];
    assert.equal(await notifyDiscord(jobs), 12);
  } finally {
    if (previous === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previous;
  }
  assert.deepEqual(bodies.map((body) => body.embeds.length), [10, 2]);
  assert.equal(bodies[0].username, "New Grad Finder");
  assert.equal(bodies[0].content, "12 new grad matches. (1/2)");
  assert.equal(bodies[0].embeds[0].description, "Stripe · Seattle, WA · swe · new grad · 2027 start");
  assert.equal(bodies[0].embeds[1].description, "Stripe · Seattle, WA · swe · no level · 2027 start");
});

test("posted time reads dates, Workday's relative text, and falls back to first seen", () => {
  const firstSeenAt = "2026-10-31T12:00:00.000Z";
  const seen = Date.parse(firstSeenAt);
  assert.equal(postedTime({ postedAt: "2026-10-29T08:00:00Z", firstSeenAt }), Date.parse("2026-10-29T08:00:00Z"));
  assert.equal(postedTime({ postedAt: "Posted Today", firstSeenAt }), seen);
  assert.equal(postedTime({ postedAt: "Posted Yesterday", firstSeenAt }), seen - 86_400_000);
  assert.equal(postedTime({ postedAt: "Posted 3 Days Ago", firstSeenAt }), seen - 3 * 86_400_000);
  assert.equal(postedTime({ postedAt: "Posted 30+ Days Ago", firstSeenAt }), seen - 30 * 86_400_000);
  assert.equal(postedTime({ postedAt: null, firstSeenAt }), seen);
  assert.equal(postedTime({ postedAt: "2099-01-01", firstSeenAt }), seen);
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.equal(timeAgo(now - 30_000, now), "just now");
  assert.equal(timeAgo(now - 45 * 60_000, now), "45m ago");
  assert.equal(timeAgo(now - 5 * 3_600_000, now), "5h ago");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(isApplied("saved"), false);
  assert.equal(isApplied("applied"), true);
  assert.equal(isApplied("interviewing"), true);
});

test("applications carry posting details and jobs can be listed newest first", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "new-grad-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const draft = (n: number) => ({
    company: "Figma",
    title: `Software Engineer, New Grad ${n}`,
    location: "San Francisco, CA",
    url: `https://boards.greenhouse.io/figma/jobs/${n}`,
    ats: "greenhouse" as const,
    targetId: "greenhouse:figma",
    externalId: String(n),
    postedAt: "2026-10-30T00:00:00Z",
  });
  const first = await store.upsertJobs([draft(1)]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertJobs([draft(2)]);
  const newest = await store.listJobs({ order: "newest", limit: 10 });
  assert.deepEqual(newest.map((job) => job.title), ["Software Engineer, New Grad 2", "Software Engineer, New Grad 1"]);
  const saved = await store.upsertApplication({ jobId: first.insertedIds[0], status: "applied" });
  assert.equal(saved.status, "applied");
  assert.equal(saved.location, "San Francisco, CA");
  assert.equal(saved.postedAt, "2026-10-30T00:00:00Z");
  assert.ok(saved.firstSeenAt);
  await store.deleteApplication(first.insertedIds[0]);
  assert.equal((await store.listApplications()).length, 0);
});
