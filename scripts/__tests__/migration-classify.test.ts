import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../migration-classify.mjs';
import { stampFor } from '../prod-schema-check.mjs';

const FILE = 'phase900_fixture.sql';
const stamped = (body: string, file = FILE) => `${body}\n${stampFor(file, body)}\n`;
const verdict = (body: string) => classify(FILE, stamped(body));

const NEW_TABLE = `
create table if not exists public.widgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  note text default 'a; b',
  created_at timestamptz not null default now()
);
alter table widgets enable row level security;
revoke all on widgets from anon, authenticated;
grant select, insert, update, delete on table widgets to service_role;
drop policy if exists own_widgets on widgets;
create policy own_widgets on widgets for select using ((select auth.uid()) = user_id);
create index if not exists widgets_user_idx on widgets (user_id, created_at desc);
comment on table widgets is 'fixture';
notify pgrst, 'reload schema';`;

describe('additive migrations', () => {
  it('a new table with RLS, its grants, policies and index', () => {
    const r = verdict(NEW_TABLE);
    expect(r).toMatchObject({ additive: true, creates: { tables: ['widgets'], columns: [], indexes: [] } });
  });

  it('columns, constraints and indexes on an existing table, with their inverse', () => {
    const r = verdict(`
alter table profiles add column if not exists tz text null, add column if not exists "Odd" int;
alter table profiles add constraint profiles_tz_len check (length(tz) < 64);
create unique index if not exists profiles_tz_idx on public.profiles (tz) where tz is not null;`);
    expect(r.additive).toBe(true);
    if (!r.additive) return;
    expect(r.creates.columns).toEqual([{ table: 'profiles', column: 'tz' }, { table: 'profiles', column: 'Odd' }]);
    expect(r.inverse).toContain('drop index if exists public.profiles_tz_idx;');
    expect(r.inverse).toContain('alter table public.profiles drop constraint if exists profiles_tz_len;');
    expect(r.inverse).toContain('alter table public.profiles drop column if exists "Odd";');
    expect(r.inverse).toContain("delete from public.migration_ledger where name = 'phase900_fixture';");
  });

  it('replacing a CHECK by name records it for the applier to restore', () => {
    const r = verdict(`
alter table coach_runs drop constraint if exists coach_runs_mode_check;
alter table coach_runs add constraint coach_runs_mode_check check (mode in ('a', 'b'));`);
    expect(r).toMatchObject({ additive: true, creates: { replacedChecks: [{ table: 'coach_runs', name: 'coach_runs_mode_check' }] } });
    if (r.additive) expect(r.inverse).toContain('{previous:coach_runs.coach_runs_mode_check}');
  });

  it('the inverse drops a new table, not its columns one by one', () => {
    const r = verdict(NEW_TABLE);
    if (!r.additive) throw new Error('expected additive');
    expect(r.inverse).toContain('drop table if exists public.widgets;');
    expect(r.inverse).not.toContain('drop column');
  });
});

describe('held, each with a reason that names the statement', () => {
  it.each([
    ['a policy on an existing table', 'create policy p on profiles for select using (true);', /policy on existing table profiles/],
    ['a policy drop on an existing table', 'drop policy if exists p on profiles;', /drops a policy on existing table profiles/],
    ['a grant on an existing table', 'grant select on profiles to authenticated;', /grants on existing table/],
    ['a grant to anon', NEW_TABLE + '\ngrant select on widgets to anon;', /grants to anon/],
    ['a grant with grant option', NEW_TABLE + '\ngrant select on widgets to authenticated with grant option;', /./],
    ['schema-wide revoke', 'revoke all on all tables in schema public from anon;', /not an additive statement/],
    ['a revoke on an existing table', 'revoke select on profiles from authenticated;', /revokes on existing table/],
    ['a table without RLS', 'create table t (id int);', /without enabling row level security/],
    ['RLS changes on an existing table', 'alter table profiles enable row level security;', /changes RLS on existing table/],
    ['RLS disabled', 'alter table profiles disable row level security;', /disable row level security/i],
    ['create table as select', 'create table t as select * from profiles;', /not an additive statement/],
    ['create table like', 'create table t (like profiles including all); alter table t enable row level security;', /uses LIKE/],
    ['a partitioned or inherited table', 'create table t (id int) inherits (profiles); alter table t enable row level security;', /clauses after its columns/],
    ['a table in another schema', 'create table auth.t (id int);', /outside public/],
    ['a function hidden in a do block', "do $$ begin execute 'drop table profiles'; end $$;", /cannot be split safely/],
    ['a do block without dollar quotes', "do 'begin null; end';", /not an additive statement: do/i],
    ['a function', 'create or replace function f() returns int language sql as $$ select 1 $$;', /cannot be split safely/],
    ['a function with a string body', "create or replace function f() returns int language sql as 'select 1';", /not an additive statement/],
    ['a view', 'create view v as select * from profiles;', /not an additive statement/],
    ['a trigger', 'create trigger t after insert on profiles for each row execute function f();', /not an additive statement/],
    ['an update', "update profiles set tz = 'UTC';", /not an additive statement/],
    ['an insert', "insert into profiles (id) values ('x');", /not an additive statement/],
    ['a drop table', 'drop table profiles;', /not an additive statement/],
    ['a drop column', 'alter table profiles drop column tz;', /alter table profiles: drop column/],
    ['an alter column', 'alter table profiles alter column tz type int;', /alter column/],
    ['a rename', 'alter table profiles rename column a to b;', /rename/],
    ['a constraint drop without a re-add', 'alter table profiles drop constraint if exists c;', /without re-adding it/],
    ['a CHECK replaced with a foreign key', 'alter table profiles drop constraint if exists c; alter table profiles add constraint c foreign key (x) references t (id);', /non-CHECK/],
    ['a cascading FK on an existing table', 'alter table profiles add constraint fk foreign key (x) references widgets (id) on delete cascade;', /cascading foreign key/],
    ['a cascading FK column on an existing table', 'alter table profiles add column w uuid references widgets (id) on delete set null;', /cascading foreign key/],
    ['an index built concurrently', 'create index concurrently i on profiles (tz);', /not an additive statement/],
    ['an unnamed index', 'create index on profiles (tz);', /not an additive statement/],
    ['an extension', 'create extension if not exists pgcrypto;', /not an additive statement/],
    ['transaction control', 'begin; alter table profiles add column x int; commit;', /not an additive statement: begin/i],
    ['an alter policy', 'alter policy p on profiles using (true);', /not an additive statement/],
    ['a $ in an identifier that hides statements', "comment on column workouts.a$q$ is 'x'; select 1; comment on column workouts.b$q$ is 'y';", /cannot be split safely: a \$ outside/],
    ['a dollar-quoted default', 'alter table profiles add column x text default $$a$$;', /cannot be split safely/],
    ['an E string', "alter table profiles add column x text default E'a\\'b';", /E'' escape string/],
    ['a nested block comment', '/* /* */ drop table profiles; */ alter table profiles add column x int;', /nested block comment/],
    ['a CHECK on an existing table that calls a function', 'alter table workouts add constraint w_chk check (some_fn(id) is not null);', /calls some_fn\(\)/],
    ['a DEFAULT on an existing table that calls a function', 'alter table workouts add column z int default bump_rate_limit();', /calls bump_rate_limit\(\)/],
    ['a schema-qualified call', 'alter table workouts add column z uuid default auth.uid();', /calls auth\.uid\(\)/],
    ['setval in a default', "alter table workouts add column z bigint default setval('s', 1);", /calls setval\(\)/],
    ['a subquery in a check', 'alter table workouts add constraint c check (x in (select id from profiles));', /a subquery/],
    ['an index expression that calls a function', 'create index if not exists wi on workouts (some_fn(id));', /index on existing table workouts calls some_fn\(\)/],
    ['a comment on an existing table', 'comment on table workouts is null;', /comments on something this file does not create/],
    ['a comment on the schema', "comment on schema public is '@graphql({})';", /comments on something this file does not create/],
    ['a comment on an existing column', "comment on column profiles.email is 'x';", /comments on something this file does not create/],
  ])('%s', (_label, body, reason) => {
    const r = verdict(body);
    expect(r.additive).toBe(false);
    if (!r.additive) expect(r.reasons.join(' | ')).toMatch(reason);
  });

  it('a missing stamp', () => {
    expect(classify(FILE, 'alter table profiles add column x int;')).toMatchObject({ additive: false, reasons: ['does not end with its ledger stamp'] });
  });

  it('an edited stamp (fingerprint of different SQL)', () => {
    const sql = `alter table profiles add column x int;\n${stampFor(FILE, 'alter table profiles add column y int;')}\n`;
    expect(classify(FILE, sql)).toMatchObject({ additive: false, reasons: ['stamp fingerprint does not match the file'] });
  });

  it("another migration's stamp", () => {
    const body = 'alter table profiles add column x int;';
    expect(classify(FILE, `${body}\n${stampFor('phase1_other.sql', body)}\n`).additive).toBe(false);
  });

  it('a statement after the stamp', () => {
    const body = 'alter table profiles add column x int;';
    const sql = `${body}\n${stampFor(FILE, body)}\nupdate profiles set x = 1;\n`;
    const r = classify(FILE, sql);
    expect(r.additive).toBe(false);
  });

  it('a keyword inside a string literal does not count', () => {
    const r = verdict("alter table profiles add column x text default 'on delete cascade';");
    expect(r.additive).toBe(true);
  });
});

describe('expressions and comments that are allowed', () => {
  it('safe built-ins in a CHECK and DEFAULT on an existing table', () => {
    const r = verdict(`alter table profiles add column if not exists tz text default lower('UTC');
alter table profiles add constraint tz_len check (tz is null or (length(tz) between 1 and 64));
alter table profiles add column if not exists c jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists w uuid references public.widgets (id);
comment on column profiles.tz is 'a comment on a column this file adds';`);
    expect(r.additive).toBe(true);
  });

  it('a new table may call anything in its defaults: it has no rows yet', () => {
    expect(verdict(NEW_TABLE.replace('default now()', 'default clock_timestamp()')).additive).toBe(true);
  });
});

describe('every migration on main', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  // The bodies (stamp synthesized for the pre-ledger files) that would apply
  // without a human. A change to the classifier that moves one of these is a
  // policy change: update this list on purpose, in a PR that says why.
  const ADDITIVE_BODIES = [
    'phase4_workout_tracking', 'phase5_coach_summary', 'phase6_quick_complete', 'phase7_occurrence_overrides',
    'phase8_exercise_definitions', 'phase11_user_api_keys', 'phase12_reviews', 'phase16_coach_profile_fields',
    'phase17_outdoor_climbing', 'phase22_meals', 'phase23_meal_coach', 'phase24_meal_favorites', 'phase26_mcp_tokens',
    'phase27_provider_sync', 'phase28_oauth_server', 'phase29_auto_sync', 'phase33_workout_templates',
    'phase34_workout_scores', 'phase35_analytics', 'phase38_coach_model', 'phase41_provider_client',
    'phase43_completion_log_unique', 'phase45_coach_runs', 'phase46_coach_conversations', 'phase47_tips_seen',
    'phase48_coach_memory', 'phase49_coach_annotations', 'phase50_coach_contract', 'phase51_coach_planner_mode',
    'phase52_live_activity_tokens', 'phase53_definition_log_fields', 'phase54_workout_exercise_notes',
    'phase57_coach_runs_modes', 'phase58_profile_timezone',
  ];

  it('classifies without throwing, and the additive set is exactly the pinned one', () => {
    const additive: string[] = [];
    for (const f of files) {
      let sql = readFileSync(new URL(f, dir), 'utf8');
      const first = classify(f, sql);
      if (!first.additive && first.reasons.includes('does not end with its ledger stamp')) sql = `${sql}\n${stampFor(f, sql)}\n`;
      if (classify(f, sql).additive) additive.push(f.replace(/\.sql$/, ''));
    }
    expect(additive).toEqual(ADDITIVE_BODIES);
  });
});
