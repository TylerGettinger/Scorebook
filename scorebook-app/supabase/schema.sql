-- Scorebook schema
-- Run this in Supabase SQL editor (Project → SQL Editor → New query)

create extension if not exists "pgcrypto";

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) on delete cascade,
  name text not null,
  number text,
  created_at timestamptz default now()
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) on delete cascade,
  opponent text,
  date date,
  is_home boolean default true,
  status text default 'live',           -- 'live' | 'final'
  our_score int default 0,
  their_score int default 0,
  state jsonb default '{}'::jsonb,       -- lineup, bases, plays, scores, report, etc.
  created_at timestamptz default now()
);

create index if not exists games_team_id_idx on games(team_id);
create index if not exists players_team_id_idx on players(team_id);

-- Realtime: let clients subscribe to live game updates
alter publication supabase_realtime add table games;

-- Row Level Security
-- This app has no per-user login — anyone with your Vercel link (and thus the
-- anon key baked into the frontend) can read and write. That mirrors how the
-- original share-link artifact worked. It's fine for a private family app, but
-- it is NOT truly access-controlled. See README "Privacy notes" for how to
-- tighten this later with Supabase Auth if you want real access control.
alter table teams enable row level security;
alter table players enable row level security;
alter table games enable row level security;

create policy "public read teams" on teams for select using (true);
create policy "public write teams" on teams for insert with check (true);
create policy "public update teams" on teams for update using (true);
create policy "public delete teams" on teams for delete using (true);

create policy "public read players" on players for select using (true);
create policy "public write players" on players for insert with check (true);
create policy "public update players" on players for update using (true);
create policy "public delete players" on players for delete using (true);

create policy "public read games" on games for select using (true);
create policy "public write games" on games for insert with check (true);
create policy "public update games" on games for update using (true);
create policy "public delete games" on games for delete using (true);
