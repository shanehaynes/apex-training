#!/usr/bin/env node
// Seed the LOCAL Supabase stack with deterministic fixture data for the
// agent@apex.local user. agent2@apex.local deliberately gets nothing — the
// integration tests use it to prove cross-user isolation.
//
// Sources (both already committed, no new personal data):
//   - src/data/schedule.json           → a recurring subset of workout_events
//   - supabase/exercise_definitions_review.json → exercise_definitions
//
// Idempotent — upserts via Prefer: resolution=merge-duplicates.

import { readFileSync } from 'node:fs';
import { localSupabaseEnv } from './lib/localEnv.mjs';

const { url, serviceKey } = localSupabaseEnv();
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates',
};

async function rest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// ── Resolve the agent user's id ───────────────────────────────────────────────

const { users } = await rest('/auth/v1/admin/users?per_page=100');
const agent = users.find(u => u.email === 'agent@apex.local');
if (!agent) {
  console.error('agent@apex.local does not exist — run scripts/create-local-users.mjs first');
  process.exit(1);
}

// ── Events: recurring backbone + a fixed one-off window ──────────────────────
// The recurring series plus every one-off event in Jul–Sep 2026 — a full,
// realistic calendar around the live specs' fake-now anchor (2026-08-03),
// still deterministic and bounded.

const ONE_OFF_FROM = '2026-07-01';
const ONE_OFF_TO = '2026-09-30';

const schedule = JSON.parse(readFileSync('src/data/schedule.json', 'utf8'));
const picked = schedule.events.filter(e =>
  (e.isRecurring && e.recurrenceRule) ||
  (!e.isRecurring && e.date >= ONE_OFF_FROM && e.date <= ONE_OFF_TO));

const eventRows = picked.map(e => ({
  user_id:             agent.id,
  id:                  e.id,
  type:                e.type,
  title:               e.title,
  subtitle:            e.subtitle ?? null,
  date:                e.date,
  start_time:          e.startTime ?? null,
  end_time:            e.endTime ?? null,
  estimated_duration:  e.estimatedDuration,
  description:         e.description ?? '',
  warmup:              e.warmup ?? [],
  exercises:           e.exercises ?? [],
  cooldown:            e.cooldown ?? [],
  difficulty:          e.difficulty,
  location:            e.location ?? null,
  cover_image_url:     e.coverImageUrl ?? null,
  tags:                e.tags ?? [],
  equipment:           e.equipment ?? [],
  is_recurring:        !!e.isRecurring,
  recurrence_rule:     e.recurrenceRule ?? null,
  cardio_targets:      e.cardioTargets ?? null,
}));

// ── Definitions: the phase-8 extraction output, review metadata stripped ─────

const review = JSON.parse(readFileSync('supabase/exercise_definitions_review.json', 'utf8'));
const definitionRows = review.definitions.map(({ review: _review, ...def }) => ({
  ...def,
  user_id: agent.id,
}));

// ── Write ─────────────────────────────────────────────────────────────────────

for (let i = 0; i < eventRows.length; i += 100) {
  await rest('/rest/v1/workout_events', { method: 'POST', body: eventRows.slice(i, i + 100) });
}
console.log(`seeded ${eventRows.length} events for agent@apex.local`);

for (let i = 0; i < definitionRows.length; i += 100) {
  await rest('/rest/v1/exercise_definitions', { method: 'POST', body: definitionRows.slice(i, i + 100) });
}
console.log(`seeded ${definitionRows.length} exercise definitions for agent@apex.local`);
