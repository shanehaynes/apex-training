import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { DEFAULT_WEIGHT_CONTEXT, weightContextFromProfile, type WeightContext } from '../../src/lib/tracking/weight.js';

// The athlete's weight context (profiles.weight_unit / body_weight_lb) for
// every server reader that classifies sets: review and analytics loaders,
// the physiology panel, the MCP tools. One read per request, service-role,
// scoped by the verified user id.
//
// Degrades, never fails: the two columns arrive by a migration applied to
// prod by hand and can trail this code, and a missing profile row is an
// account that has logged nothing. Either way the answer is the default —
// pounds, no body weight — which is exactly what every row meant before
// the context existed.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * The context, or null when the database could not say: a failed read, no
 * profile row, or a row without the weight_unit column. Never logs — for a
 * caller that already reports its own degradation (the physiology panel).
 */
export async function readWeightContext(supabase: Admin, userId: string): Promise<WeightContext | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('weight_unit, body_weight_lb')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { weight_unit?: unknown; body_weight_lb?: unknown };
    return row.weight_unit === undefined ? null : weightContextFromProfile(row);
  } catch {
    return null;
  }
}

/** readWeightContext with the default in place of null, warned once so a silent lb fallback is not silent. */
export async function fetchWeightContext(supabase: Admin, userId: string): Promise<WeightContext> {
  const ctx = await readWeightContext(supabase, userId);
  if (ctx) return ctx;
  console.warn('[api] weight context unavailable, reading weights as pounds');
  return DEFAULT_WEIGHT_CONTEXT;
}
