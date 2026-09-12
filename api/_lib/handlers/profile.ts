import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { getAnthropicKey, keyLast4, validateAnthropicKey } from '../anthropicKey.js';
import { encryptSecret, hasEncryptionSecret } from '../keyCrypto.js';
import { enforceRateLimit } from '../rateLimit.js';
import { isCurrent, latestAcceptance } from '../legal.js';
import { COACH_MODELS, isCoachModelId, resolveCoachModel } from '../../../src/lib/coach/models.js';
import { publicOrigin } from '../oauth/common.js';

// Profile reads/writes, same posture as every other table: the browser
// reads profiles via RLS (own row only) and mutates through this
// service-role endpoint. Strict allowlist — is_template_source,
// template_copied_at, and ics_token are never client-writable.
//
// Also owns the user's Anthropic API key (server-only user_api_keys
// table): PATCH { anthropic_api_key } saves/replaces/removes it, GET
// reports { hasAnthropicKey, anthropicKeyLast4 }. The raw key is never
// logged and never echoed back in any response.

const AVATAR_KEYS = [
  'goat', 'ibex', 'snow-leopard', 'eagle', 'wolf',
  'bighorn', 'marmot', 'raven', 'lynx', 'fox',
  'bear', 'owl', 'falcon', 'pika', 'elk',
  'wolverine', 'cougar', 'chamois', 'yak', 'hare',
  'orca', 'seal', 'otter', 'octopus',
];

async function keyStatus(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>, userId: string) {
  const key = await getAnthropicKey(supabase, userId);
  return { hasAnthropicKey: key !== null, anthropicKeyLast4: key ? keyLast4(key) : null };
}

// The profiles row, for clients that do not read it directly. The web reads
// it over RLS through AuthContext; the native app does not (W6 put the coach
// model here for exactly that reason — "so the native app's badge never reads
// the profiles row directly"), and W11's You tab needs the rest of it.
//
// `coachModel` is the stored column as is (null = follow the default);
// `coachModelLabel` is what a badge shows, resolved the same way /api/chat
// resolves the request body, so a retired id reads as the default it will
// actually run on.
//
// `calendarFeedUrl` is composed here rather than shipping the bare ics_token,
// so no client has to know how the feed URL is spelled — the web builds the
// same string in ProfileView.tsx. It is the same secret the browser already
// holds via the profiles row, not a new exposure, and it is only ever sent to
// the authenticated owner of the row.
async function profileFields(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>, userId: string, req: VercelRequest,
) {
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, avatar_key, coach_goal, coach_context, coach_model, max_hr, threshold_hr, ics_token')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const stored = typeof data?.coach_model === 'string' ? data.coach_model : null;
  return {
    displayName: data?.display_name ?? null,
    avatarKey: data?.avatar_key ?? null,
    coachGoal: data?.coach_goal ?? null,
    coachContext: data?.coach_context ?? null,
    maxHr: data?.max_hr ?? null,
    thresholdHr: data?.threshold_hr ?? null,
    coachModel: stored,
    coachModelLabel: resolveCoachModel(stored).label,
    calendarFeedUrl: data?.ics_token ? `${publicOrigin(req)}/api/calendar-feed?token=${data.ics_token}` : null,
  };
}

// The picker's options, so a native client never hand-ports the catalog
// (D-008). `params` is deliberately omitted: it is a server request shape,
// not something a picker renders.
const coachModelCatalog = () => COACH_MODELS.map(({ id, label, badge, blurb, inputPerMTok, outputPerMTok }) => ({
  id, label, badge, blurb, inputPerMTok, outputPerMTok,
}));

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  // GET is exempt from the terms gate; PATCH is not. The app shell fetches
  // this endpoint on every load to learn the key status, and it is also
  // where it learns whether the acceptance modal is due — gating it would
  // mean a blocked user could never be told why they are blocked.
  const userId = await requireUser(req, res, { skipTermsGate: req.method === 'GET' });
  if (!userId) return;

  if (req.method === 'GET') {
    try {
      const [keys, accepted, fields] = await Promise.all([
        keyStatus(supabase, userId),
        latestAcceptance(supabase, userId),
        profileFields(supabase, userId, req),
      ]);
      res.status(200).json({
        ...keys,
        ...fields,
        coachModels: coachModelCatalog(),
        termsAccepted: accepted,
        termsCurrent: isCurrent(accepted),
      });
    } catch (err) {
      console.error('[api/profile] status failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to load key status');
    }
    return;
  }

  // PATCH only — the key path below calls out to Anthropic, and without a
  // limit this endpoint doubles as a free key-validity oracle for arbitrary
  // sk-ant-* strings.
  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  const body = req.body as {
    display_name?: unknown;
    avatar_key?: unknown;
    coach_goal?: unknown;
    coach_context?: unknown;
    coach_model?: unknown;
    onboarding_dismissed?: unknown;
    anthropic_api_key?: unknown;
    max_hr?: unknown;
    threshold_hr?: unknown;
  } | undefined;

  const fields: Record<string, string | number | null> = {};

  if (body?.display_name !== undefined) {
    if (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.length > 80) {
      res.status(400).send('Invalid display_name');
      return;
    }
    fields.display_name = body.display_name.trim();
  }

  if (body?.avatar_key !== undefined) {
    if (typeof body.avatar_key !== 'string' || !AVATAR_KEYS.includes(body.avatar_key)) {
      res.status(400).send('Invalid avatar_key');
      return;
    }
    fields.avatar_key = body.avatar_key;
  }

  // Coach fields accept '' — clearing them is a valid edit.
  if (body?.coach_goal !== undefined) {
    if (typeof body.coach_goal !== 'string' || body.coach_goal.length > 200) {
      res.status(400).send('Invalid coach_goal');
      return;
    }
    fields.coach_goal = body.coach_goal.trim();
  }

  if (body?.coach_context !== undefined) {
    if (typeof body.coach_context !== 'string' || body.coach_context.length > 1000) {
      res.status(400).send('Invalid coach_context');
      return;
    }
    fields.coach_context = body.coach_context.trim();
  }

  // Which model the coach runs on. null clears the pick, putting the user
  // back on DEFAULT_COACH_MODEL — the column has no CHECK constraint, so this
  // allowlist is the only thing keeping a junk id out of the row.
  if (body?.coach_model !== undefined) {
    if (body.coach_model !== null && !isCoachModelId(body.coach_model)) {
      res.status(400).send('Invalid coach_model');
      return;
    }
    fields.coach_model = body.coach_model;
  }

  // A one-way latch, and deliberately not a timestamp the client supplies:
  // `true` stamps now(), and there is no way to un-dismiss. Anything else is
  // a bug in the caller, not a request to clear the flag.
  if (body?.onboarding_dismissed !== undefined) {
    if (body.onboarding_dismissed !== true) {
      res.status(400).send('Invalid onboarding_dismissed');
      return;
    }
    fields.onboarding_dismissed_at = new Date().toISOString();
  }

  // HR-zone settings (phase 35): nullable ints — null clears a value the
  // user no longer stands behind. Bounds mirror the DB CHECK constraints so
  // a bad value 400s here instead of 500ing on the constraint.
  if (body?.max_hr !== undefined) {
    if (body.max_hr !== null && (typeof body.max_hr !== 'number' || !Number.isInteger(body.max_hr) || body.max_hr < 100 || body.max_hr > 250)) {
      res.status(400).send('max_hr must be an integer between 100 and 250, or null');
      return;
    }
    fields.max_hr = body.max_hr;
  }

  if (body?.threshold_hr !== undefined) {
    if (body.threshold_hr !== null && (typeof body.threshold_hr !== 'number' || !Number.isInteger(body.threshold_hr) || body.threshold_hr < 80 || body.threshold_hr > 230)) {
      res.status(400).send('threshold_hr must be an integer between 80 and 230, or null');
      return;
    }
    fields.threshold_hr = body.threshold_hr;
  }

  const hasKeyChange = body !== undefined && 'anthropic_api_key' in body;
  if (Object.keys(fields).length === 0 && !hasKeyChange) {
    res.status(400).send('No updatable fields');
    return;
  }

  if (hasKeyChange) {
    if (body!.anthropic_api_key === null) {
      const { error } = await supabase.from('user_api_keys').delete().eq('user_id', userId);
      if (error) {
        console.error('[api/profile] key delete failed:', error.message);
        res.status(500).send('Failed to remove API key');
        return;
      }
    } else {
      const raw = body!.anthropic_api_key;
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (!key.startsWith('sk-ant-') || key.length < 20 || key.length > 300) {
        res.status(400).send('Invalid Anthropic API key format — keys start with sk-ant-');
        return;
      }

      // Anthropic's refusals are actionable by the user (wrong key, wrong
      // workspace scope), so they get the reason; only a genuine failure to
      // reach Anthropic is worth a "try again".
      const check = await validateAnthropicKey(key);
      if (check.verdict === 'rejected') {
        res.status(400).send(check.message);
        return;
      }
      if (check.verdict === 'unreachable') {
        res.status(502).send("Couldn't reach Anthropic to verify the key — try again in a moment");
        return;
      }

      if (!hasEncryptionSecret()) {
        // Deliberately not fatal: a missing env var must not brick key
        // saves, but every save without it stores plaintext.
        console.error('[api/profile] API_KEY_ENCRYPTION_SECRET is not set — storing API key UNENCRYPTED');
      }
      const stored = hasEncryptionSecret() ? encryptSecret(key) : key;
      const { error } = await supabase
        .from('user_api_keys')
        .upsert(
          { user_id: userId, anthropic_api_key: stored, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        );
      if (error) {
        console.error('[api/profile] key upsert failed:', error.message);
        res.status(500).send('Failed to save API key');
        return;
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    const { error } = await supabase
      .from('profiles')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) {
      console.error('[api/profile] update failed:', error.message);
      res.status(500).send('Failed to update profile');
      return;
    }
  }

  try {
    res.status(200).json({ ok: true, ...(await keyStatus(supabase, userId)) });
  } catch {
    // Write succeeded; only the status readback failed. Don't fail the PATCH.
    res.status(200).json({ ok: true });
  }
}
