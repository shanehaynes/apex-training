import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { CONTRACT_MAX, contractsEqual, normalizeContract } from '../../../src/lib/coach/contract.js';

// The coaching contract's one server-side door (lane D01): the read every
// prompt and every proposal starts from, and the write the two accept paths
// share — the chat tool propose_contract_edit (api/_lib/handlers/coachTool.ts)
// and the reflection's accept (api/_lib/handlers/coachReflections.ts). The
// notebook's direct edit goes through /api/profile, which applies the same
// normalization (src/lib/coach/contract.ts), so the three writers agree.
//
// The column arrives by a HELD migration applied to prod by hand, so until
// then a select of it fails with 42703 (or PGRST204 from PostgREST's schema
// cache). The read treats that as "no contract" — the prompt drops the
// section, the reflection sees '' — and the write reports it, so a proposal
// is refused with a reason rather than a 500.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export function isContractColumnMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204')
    && /coach_contract/.test(error.message ?? '');
}

/**
 * The stored column as is — null for no row, no contract, or no column yet.
 * The raw value is what the compare-and-set below keys on: the write is
 * conditional on the exact bytes this read saw, so a normalized reading is
 * not enough there. Throws on any other database error.
 */
async function readRawContract(supabase: Admin, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('coach_contract')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    if (isContractColumnMissing(error)) return null;
    throw new Error(`coach_contract fetch failed: ${error.message}`);
  }
  return typeof data?.coach_contract === 'string' ? data.coach_contract : null;
}

/**
 * This user's contract, normalized, or '' when there is none — including the
 * column not existing yet. Throws on any other database error; callers that
 * must not fail a turn catch and degrade.
 */
export async function readCoachContract(supabase: Admin, userId: string): Promise<string> {
  return normalizeContract(await readRawContract(supabase, userId));
}

export type ContractWrite =
  | { ok: true; contract: string }
  | { ok: false; reason: string };

function changedSince(current: string): ContractWrite {
  return { ok: false, reason: `The contract changed since this proposal was made. It now reads:\n${current || '(empty)'}\nRe-read it and propose again.` };
}

/**
 * Replace the contract with `after` when `expectedBefore` still matches what
 * is stored — the optimistic check that keeps a proposal made against last
 * week's text from overwriting an edit the athlete made since. Never throws:
 * the outcome is text the caller can show or return to the model.
 *
 * A compare-and-set, not a read-then-write: the update is conditional on
 * the raw value the read saw, so two accepts of the same proposal (two
 * tabs, a double click, a chat card and the notebook at once) cannot both
 * pass the normalized check and have the second silently overwrite the
 * first — the row no longer matches, the update touches nothing, and the
 * loser gets the "changed since" refusal like any other stale proposal.
 */
export async function applyContractEdit(
  supabase: Admin,
  userId: string,
  expectedBefore: unknown,
  after: unknown,
): Promise<ContractWrite> {
  const next = normalizeContract(after);
  if (next.length > CONTRACT_MAX) {
    return { ok: false, reason: `The contract must be ${CONTRACT_MAX} characters or fewer (this one is ${next.length}). Shorten it and retry.` };
  }
  let raw: string | null;
  try {
    raw = await readRawContract(supabase, userId);
  } catch (err) {
    console.warn('[coach-contract] read failed:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'The contract is unavailable right now; nothing was changed.' };
  }
  const current = normalizeContract(raw);
  if (!contractsEqual(current, expectedBefore)) return changedSince(current);
  if (contractsEqual(current, next)) {
    return { ok: true, contract: current };
  }
  let query = supabase
    .from('profiles')
    .update({ coach_contract: next, updated_at: new Date().toISOString() })
    .eq('id', userId);
  query = raw === null ? query.is('coach_contract', null) : query.eq('coach_contract', raw);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) {
    if (isContractColumnMissing(error)) {
      return { ok: false, reason: 'The coaching contract is not available on this server yet; nothing was changed.' };
    }
    return { ok: false, reason: `Contract write failed: ${error.message}. Nothing was changed.` };
  }
  if (!data) {
    // The stored value moved between the read and the write. Re-read so
    // the refusal shows what it says now, or the best we know if that fails.
    const now = await readCoachContract(supabase, userId).catch(() => current);
    return changedSince(now);
  }
  return { ok: true, contract: next };
}
