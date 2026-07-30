-- LetsFly — AI usage tracking, used by the `ai` Edge Function to cap
-- how many AI requests a single user can make per day.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.ai_usage (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The function queries by (user, recent time), so index that.
create index if not exists ai_usage_user_time
  on public.ai_usage (user_id, created_at desc);

-- Lock the table down: only the service role (i.e. the Edge Function) may read
-- or write it. No client-side policy is granted, so the browser cannot tamper
-- with its own usage counts.
alter table public.ai_usage enable row level security;

-- Optional housekeeping: drop rows older than 30 days so the table stays small.
-- Schedule via pg_cron if you have it enabled, or run occasionally by hand.
-- delete from public.ai_usage where created_at < now() - interval '30 days';
