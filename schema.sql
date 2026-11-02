-- Paste into the Supabase SQL editor when STORE=supabase.
-- The poller and the dashboard both use the service role, server-side.

create table if not exists targets (
  id text primary key,
  company text not null,
  ats text not null,
  board_token text,
  workday_host text,
  workday_tenant text,
  workday_site text,
  enabled integer not null default 1,
  interval_minutes integer not null default 360,
  last_polled_at timestamptz,
  last_status text,
  last_error text,
  last_ok_at timestamptz,
  created_at timestamptz not null default now()
);

-- Safe to re-run this whole file. This line upgrades databases created before last_ok_at existed.
alter table targets add column if not exists last_ok_at timestamptz;
update targets set last_ok_at = last_polled_at where last_ok_at is null and last_status = 'ok';

-- Board types are checked by the app (lib/types.ts ATS), so new types need no schema change.
alter table targets drop constraint if exists targets_ats_check;

create table if not exists jobs (
  id text primary key,
  canonical_url text not null unique,
  title text not null,
  company text not null,
  location text,
  ats text not null,
  target_id text,
  external_id text,
  posted_at text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source_urls jsonb not null default '[]'::jsonb,
  title_key text not null,
  is_entry integer,
  role_family text,
  seniority text,
  score double precision,
  classify_reason text,
  classify_model text,
  season text,
  degree text,
  us integer,
  match integer,
  posting_key text,
  role_key text,
  alerted_at timestamptz
);

alter table jobs add column if not exists season text;
alter table jobs add column if not exists degree text;
alter table jobs add column if not exists us integer;
alter table jobs add column if not exists match integer;
-- Cross-source duplicate keys: the ATS's own posting id, and company + title.
alter table jobs add column if not exists posting_key text;
alter table jobs add column if not exists role_key text;

create index if not exists jobs_title_key_idx on jobs (title_key);
create index if not exists jobs_first_seen_idx on jobs (first_seen_at desc);
create index if not exists jobs_score_idx on jobs (score desc);
create index if not exists jobs_classify_model_idx on jobs (classify_model);
create index if not exists jobs_match_idx on jobs (match);
create index if not exists jobs_posting_key_idx on jobs (posting_key);
create index if not exists jobs_role_key_idx on jobs (role_key);

create table if not exists classifications (
  cache_key text primary key,
  title text not null,
  is_entry integer not null,
  role_family text not null,
  seniority text not null,
  season text,
  degree text,
  score double precision not null,
  reason text not null,
  model text not null,
  created_at timestamptz not null default now()
);

alter table classifications add column if not exists season text;
alter table classifications add column if not exists degree text;

-- Model answers for "is this location in the US?", one row per location string.
create table if not exists locations (
  cache_key text primary key,
  location text not null,
  us integer,
  model text not null,
  created_at timestamptz not null default now()
);

-- Titles labelled before season and degree existed get labelled again.
delete from classifications where season is null;
update jobs set classify_model = null where match is null and classify_model is not null;

create table if not exists applications (
  job_id text primary key references jobs (id) on delete cascade,
  status text not null check (status in ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'hidden')),
  notes text not null default '',
  updated_at timestamptz not null default now()
);

-- Databases made before the "hidden" status get the wider check.
alter table applications drop constraint if exists applications_status_check;
alter table applications add constraint applications_status_check
  check (status in ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'hidden'));

create table if not exists poll_runs (
  id bigint generated always as identity primary key,
  target_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  jobs_seen integer not null,
  jobs_new integer not null,
  error text
);

create index if not exists poll_runs_started_idx on poll_runs (started_at);

-- RLS on with no policies: the public anon key gets nothing.
-- The service role / secret key bypasses RLS, so the app is unaffected.
alter table targets enable row level security;
alter table jobs enable row level security;
alter table classifications enable row level security;
alter table applications enable row level security;
alter table poll_runs enable row level security;
alter table locations enable row level security;
