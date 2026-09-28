import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import type { CoachMemoryRow, CoachReflectionRow } from '../../../src/lib/db/types.js';
import { contractsEqual } from '../../../src/lib/coach/contract.js';
import { REFLECTION_MEMORY_CAP } from './prompt.js';
import type { ContractProposal, MemoryProposal, ReflectionOutput } from './parse.js';

// Turning a parsed reflection into rows (lane D01): the dedupe and the cap
// are pure and tested on their own; the writes are two statements against
// the service-role client — the memory proposals first, then the reflection
// row flipped to `done` with their ids — so a run that dies between them
// leaves proposals a retry will dedupe against, never a done row that names
// proposals which do not exist.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The memory proposals worth writing: not already live or pending for this
 * user (by normalized text), not a repeat within the batch, at most the cap,
 * highest confidence first so the cap keeps the strongest.
 */
export function selectMemoryProposals(proposals: MemoryProposal[], existingTexts: string[]): MemoryProposal[] {
  const seen = new Set(existingTexts.map(normalized));
  const kept: MemoryProposal[] = [];
  for (const p of [...proposals].sort((a, b) => b.confidence - a.confidence)) {
    const key = normalized(p.content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
    if (kept.length >= REFLECTION_MEMORY_CAP) break;
  }
  return kept;
}

/** A contract proposal is one only when it differs from the contract it was made against. */
export function selectContractProposal(proposal: ContractProposal | null, before: string): ContractProposal | null {
  if (!proposal || contractsEqual(proposal.after, before)) return null;
  return proposal;
}

export interface ApplyResult {
  row: CoachReflectionRow;
  memoriesProposed: number;
  contractProposed: boolean;
}

/**
 * Write one reflection's proposals and finish its row. `existingTexts` is
 * the confirmed set plus the pending set as read before the model call — the
 * dedupe both against what the athlete knows and against a previous run
 * that died after inserting.
 */
export async function applyReflection(
  supabase: Admin,
  row: Pick<CoachReflectionRow, 'id' | 'user_id'>,
  output: ReflectionOutput,
  context: { contractBefore: string; existingTexts: string[] },
  now = new Date(),
): Promise<ApplyResult> {
  const memories = selectMemoryProposals(output.memories, context.existingTexts);
  const contract = selectContractProposal(output.contract, context.contractBefore);

  let ids: string[] = [];
  if (memories.length > 0) {
    const { data, error } = await supabase
      .from('coach_memory')
      .insert(memories.map(m => ({
        user_id: row.user_id,
        kind: m.kind,
        content: m.content,
        confidence: m.confidence,
        source_kind: 'reflection',
        source_id: row.id,
        confirmed_at: null,
      })))
      .select('id');
    if (error) throw new Error(`coach_memory insert failed: ${error.message}`);
    ids = ((data ?? []) as Array<Pick<CoachMemoryRow, 'id'>>).map(r => r.id);
  }

  const stamp = now.toISOString();
  const { data, error } = await supabase
    .from('coach_reflections')
    .update({
      status: 'done',
      contract_before: context.contractBefore,
      contract_after: contract?.after ?? null,
      reason: contract?.reason ?? null,
      memory_proposal_ids: ids,
      error: null,
      completed_at: stamp,
      // Nothing to accept or reject when no contract edit was proposed: the
      // memory proposals are confirmed one by one through /api/coach-memory.
      resolved_at: contract ? null : stamp,
    })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .select('*')
    .single();
  if (error || !data) throw new Error(`coach_reflections update failed: ${error?.message ?? 'no row'}`);
  return { row: data as CoachReflectionRow, memoriesProposed: ids.length, contractProposed: contract !== null };
}

/** Finish a row that proposed nothing because the day held nothing to reflect on. */
export async function completeEmptyReflection(
  supabase: Admin,
  row: Pick<CoachReflectionRow, 'id' | 'user_id'>,
  contractBefore: string,
  now = new Date(),
): Promise<CoachReflectionRow> {
  const stamp = now.toISOString();
  const { data, error } = await supabase
    .from('coach_reflections')
    .update({
      status: 'done',
      contract_before: contractBefore,
      contract_after: null,
      reason: null,
      memory_proposal_ids: [],
      error: null,
      completed_at: stamp,
      resolved_at: stamp,
    })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .select('*')
    .single();
  if (error || !data) throw new Error(`coach_reflections update failed: ${error?.message ?? 'no row'}`);
  return data as CoachReflectionRow;
}

/** Record why a reflection could not finish; the next run retries it. */
export async function failReflection(
  supabase: Admin,
  row: Pick<CoachReflectionRow, 'id' | 'user_id'>,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from('coach_reflections')
    .update({ status: 'failed', error: message.slice(0, 2000) })
    .eq('id', row.id)
    .eq('user_id', row.user_id);
  if (error) console.error('[reflection] failed to record the failure:', error.message);
}
