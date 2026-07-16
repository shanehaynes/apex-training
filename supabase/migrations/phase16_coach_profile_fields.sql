-- AI Coach personalization: the athlete's stated goal and free-form context,
-- injected into the coach's system prompt (chat + post-workout summaries).
-- Empty string means "not set" — same convention as display_name.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS coach_goal    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS coach_context TEXT NOT NULL DEFAULT '';
