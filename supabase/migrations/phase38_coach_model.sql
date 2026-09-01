-- Phase 38: per-user coach model.
--
-- The coach spends the user's own Anthropic key, so which model it runs on
-- is a line on their bill. This column stores their pick from the catalog in
-- src/lib/coach/models.ts.
--
-- Nullable, and deliberately NOT constrained to a list of ids:
--   * null means "follow the app default" — bumping DEFAULT_COACH_MODEL then
--     moves every user who never chose, with no backfill.
--   * a CHECK against hardcoded ids would need a migration every time
--     Anthropic ships a model. Validation lives in the PATCH /api/profile
--     allowlist instead, and resolveCoachModel() falls back to the default
--     for any id later retired from the catalog.

alter table public.profiles add column if not exists coach_model text;

comment on column public.profiles.coach_model is
  'Chosen coach model id from src/lib/coach/models.ts; null = follow DEFAULT_COACH_MODEL.';
