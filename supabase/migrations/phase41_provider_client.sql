-- Phase 41: which client started a provider OAuth connect.
--
-- WHY THIS EXISTS
-- The COROS consent screen redirects to /api/provider-callback as a plain
-- browser navigation with no Supabase JWT, so the only thing the callback
-- knows about the user is the unguessable `state` parked on the pending row
-- by connect-start. That was enough while every connect started in the web
-- app and every callback bounced back into the SPA. The native app (W11)
-- starts the same flow inside ASWebAuthenticationSession, which can only be
-- dismissed by a redirect to the app's own scheme — so the callback has to
-- know, at redirect time, which client to send the user back to, and the
-- pending row is the one place that survives the round trip.
--
-- Nullable, and deliberately NOT constrained to a list of clients:
--   * null means the web app — the original behaviour, and what every row
--     written before this migration means, so no backfill is needed.
--   * 'ios' is the only value the API writes today. A CHECK against a
--     hardcoded list would need a migration for every future client, so
--     validation lives in the /api/provider-sync allowlist instead
--     (an unknown value is a 400 there and is never stored), the same call
--     phase38 made for profiles.coach_model.
--
-- connect-start writes the column on every attempt, including the web's
-- (as null): the pending row is upserted on (user_id, provider), so leaving
-- it out would let an 'ios' value from an abandoned attempt redirect a later
-- web connect into the app.

alter table public.provider_connections add column if not exists client text;

comment on column public.provider_connections.client is
  'Client that started the pending OAuth: ''ios'' for the native app, null for the web. Read by /api/provider-callback to pick the redirect target.';
