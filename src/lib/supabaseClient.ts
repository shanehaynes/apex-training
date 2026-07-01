import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Returns null when env vars are missing (dev without .env.local, or missing Vercel config).
// ScheduleContext falls back to localStorage-only mode in this case.
export const supabase = url && key ? createClient(url, key) : null;

export interface CompletionRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  is_completed: boolean;
  completed_at: string | null;
  updated_at: string;
}

export interface CompletionLogRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  action: 'complete' | 'uncomplete';
}

// Row shape returned by Supabase for workout_events (snake_case DB columns).
export interface WorkoutEventRow {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  estimated_duration: number;
  description: string;
  warmup: unknown[];
  exercises: unknown[];
  cooldown: unknown[];
  difficulty: number;
  location: string | null;
  cover_image_url: string | null;
  tags: string[];
  equipment: string[];
  is_recurring: boolean;
  /** Canonical RFC 5545 RRULE value (no 'RRULE:' prefix) — see src/lib/recurrence/. */
  recurrence_rule: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_frequency: string | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_days: number[] | null;
  /** @deprecated Superseded by recurrence_rule. */
  recurring_end_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringExceptionRow {
  id: string;
  event_id: string;
  skipped_date: string;
  created_at: string;
}

export interface EventMutationLogRow {
  operation: 'create' | 'update' | 'delete' | 'delete_instance';
  event_id: string;
  event_title: string;
  event_date?: string;
  diff?: Record<string, unknown>;
  triggered_by?: string;
}
