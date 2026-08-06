import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { deleteJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import type { ObjectiveRow, TrainingBlockRow } from '../lib/db/types';
import type { Objective, TrainingBlock } from '../types/blocks';
import {
  blockFieldsToRow,
  blockToRow,
  objectiveFieldsToRow,
  objectiveToRow,
  rowToBlock,
  rowToObjective,
} from '../lib/blocks/mapping';
import { blockCovering } from '../lib/blocks/period';
import { validateBlock } from '../lib/blocks/validate';
import { registerAgentState } from '../dev/agentBridge';
import { now } from '../lib/clock';

// A provider rather than a bare hook: the calendar strip and the blocks view
// can both be mounted, and a hook would fetch twice. Mirrors ScheduleContext's
// posture — anon-client reads under RLS, all writes through /api, realtime
// re-fetch, and a graceful empty state when Supabase isn't configured.

export interface BlocksSnapshot {
  blocks: TrainingBlock[];
  objectives: Objective[];
}

interface BlocksContextValue {
  blocks: TrainingBlock[];
  objectives: Objective[];
  isLoading: boolean;
  /**
   * Resolves with the loaded blocks once the initial fetch settles. Use this
   * — not the `blocks` array — anywhere a stale-empty read would silently
   * produce wrong output, such as building the coach's system prompt.
   */
  whenLoaded: () => Promise<BlocksSnapshot>;
  /** The block covering a YYYY-MM-DD date, or null. Single-valued: blocks can't overlap. */
  blockFor: (date: string) => TrainingBlock | null;
  /** The block covering today. */
  activeBlock: TrainingBlock | null;
  objectiveFor: (block: TrainingBlock) => Objective | null;
  refresh: () => Promise<void>;
  createBlock: (input: Omit<TrainingBlock, 'id'>) => Promise<{ id: string } | null>;
  /**
   * Create several blocks atomically — all land or none do. Use this for a
   * training cycle, where a partial write would leave a half-plan behind.
   */
  createBlocks: (inputs: Omit<TrainingBlock, 'id'>[]) => Promise<{ ids: string[] } | null>;
  updateBlock: (id: string, fields: Partial<Omit<TrainingBlock, 'id'>>) => Promise<boolean>;
  deleteBlock: (id: string, name: string) => Promise<boolean>;
  createObjective: (input: Omit<Objective, 'id'>) => Promise<{ id: string } | null>;
  updateObjective: (id: string, fields: Partial<Omit<Objective, 'id'>>) => Promise<boolean>;
  deleteObjective: (id: string, name: string) => Promise<boolean>;
}

const BlocksContext = createContext<BlocksContextValue | null>(null);

const ENDPOINT = '/api/training-blocks';

export function BlocksProvider({ children }: { children: React.ReactNode }) {
  const [blocks, setBlocks] = useState<TrainingBlock[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [isLoading, setIsLoading] = useState(!!supabase);

  // The in-flight (or last completed) load. Callers that must not race the
  // initial fetch — the coach prompt especially — await this instead of
  // reading React state, which only settles a render later.
  const loadRef = useRef<Promise<BlocksSnapshot> | null>(null);

  const fetchAll = useCallback(async (): Promise<BlocksSnapshot> => {
    if (!supabase) {
      // Offline mode: no blocks, and the UI renders nothing rather than erroring.
      setBlocks([]);
      setObjectives([]);
      setIsLoading(false);
      return { blocks: [], objectives: [] };
    }

    const [blocksRes, objectivesRes] = await Promise.all([
      supabase.from('training_blocks').select('*').order('start_date'),
      supabase.from('objectives').select('*').order('target_date', { nullsFirst: false }),
    ]);

    let nextBlocks: TrainingBlock[] = [];
    let nextObjectives: Objective[] = [];

    if (blocksRes.error) console.warn('[apex] Failed to load training_blocks:', blocksRes.error.message);
    else {
      nextBlocks = (blocksRes.data as TrainingBlockRow[]).map(rowToBlock);
      setBlocks(nextBlocks);
    }

    if (objectivesRes.error) console.warn('[apex] Failed to load objectives:', objectivesRes.error.message);
    else {
      nextObjectives = (objectivesRes.data as ObjectiveRow[]).map(rowToObjective);
      setObjectives(nextObjectives);
    }

    setIsLoading(false);
    return { blocks: nextBlocks, objectives: nextObjectives };
  }, []);

  const refresh = useCallback(async () => {
    const load = fetchAll();
    loadRef.current = load;
    await load;
  }, [fetchAll]);

  /** Resolves with the loaded blocks — starting the fetch if none has run. */
  const whenLoaded = useCallback((): Promise<BlocksSnapshot> => {
    if (!loadRef.current) loadRef.current = fetchAll();
    return loadRef.current;
  }, [fetchAll]);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime delivery is authorized against the phase19 SELECT policies, so
  // each user only ever receives their own row changes.
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const channel = sb
      .channel('blocks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'training_blocks' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'objectives' }, refresh)
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [refresh]);

  // ── Writes ────────────────────────────────────────────────────────────────

  const createBlock = useCallback(async (input: Omit<TrainingBlock, 'id'>) => {
    validateBlock(input);
    const res = await postJson<{ id: string }>(
      ENDPOINT,
      { ...blockToRow(input), triggered_by: 'user', log: { resource_name: input.name, triggered_by: 'user' } },
      'Create block',
    );
    await refresh();
    return res ?? null;
  }, [refresh]);

  const createBlocks = useCallback(async (inputs: Omit<TrainingBlock, 'id'>[]) => {
    inputs.forEach(validateBlock);
    const res = await postJson<{ ids: string[] }>(
      `${ENDPOINT}?batch=1`,
      {
        rows: inputs.map(blockToRow),
        log: { resource_name: inputs[0]?.name ?? 'cycle', triggered_by: 'user' },
      },
      'Create blocks',
    );
    await refresh();
    return res ?? null;
  }, [refresh]);

  const updateBlock = useCallback(async (id: string, fields: Partial<Omit<TrainingBlock, 'id'>>) => {
    const existing = blocks.find(b => b.id === id);
    if (existing) validateBlock({ ...existing, ...fields });
    await patchJson(
      `${ENDPOINT}?id=${encodeURIComponent(id)}`,
      { fields: blockFieldsToRow(fields), log: { resource_name: fields.name ?? existing?.name ?? id, triggered_by: 'user' } },
      'Update block',
    );
    await refresh();
    return true;
  }, [blocks, refresh]);

  const deleteBlock = useCallback(async (id: string, name: string) => {
    await deleteJson(`${ENDPOINT}?id=${encodeURIComponent(id)}`, 'Delete block', {
      log: { resource_name: name, triggered_by: 'user' },
    });
    await refresh();
    return true;
  }, [refresh]);

  const createObjective = useCallback(async (input: Omit<Objective, 'id'>) => {
    const res = await postJson<{ id: string }>(
      `${ENDPOINT}?resource=objective`,
      { ...objectiveToRow(input), triggered_by: 'user', log: { resource_name: input.name, triggered_by: 'user' } },
      'Create objective',
    );
    await refresh();
    return res ?? null;
  }, [refresh]);

  const updateObjective = useCallback(async (id: string, fields: Partial<Omit<Objective, 'id'>>) => {
    const existing = objectives.find(o => o.id === id);
    await patchJson(
      `${ENDPOINT}?resource=objective&id=${encodeURIComponent(id)}`,
      { fields: objectiveFieldsToRow(fields), log: { resource_name: fields.name ?? existing?.name ?? id, triggered_by: 'user' } },
      'Update objective',
    );
    await refresh();
    return true;
  }, [objectives, refresh]);

  const deleteObjective = useCallback(async (id: string, name: string) => {
    await deleteJson(`${ENDPOINT}?resource=objective&id=${encodeURIComponent(id)}`, 'Delete objective', {
      log: { resource_name: name, triggered_by: 'user' },
    });
    await refresh();
    return true;
  }, [refresh]);

  // ── Lookups ───────────────────────────────────────────────────────────────

  const blockFor = useCallback((date: string) => blockCovering(blocks, date), [blocks]);
  const activeBlock = useMemo(() => blockCovering(blocks, format(now(), 'yyyy-MM-dd')), [blocks]);
  const objectiveFor = useCallback(
    (block: TrainingBlock) => objectives.find(o => o.id === block.objectiveId) ?? null,
    [objectives],
  );

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('blocks', () => ({
      blocks: blocks.map(b => ({
        id: b.id, name: b.name, startDate: b.startDate, endDateExclusive: b.endDateExclusive,
      })),
      activeBlockId: activeBlock?.id ?? null,
      objectives: objectives.map(o => ({ id: o.id, name: o.name, targetDate: o.targetDate ?? null })),
    }));
  }, [blocks, activeBlock, objectives]);

  const value = useMemo<BlocksContextValue>(() => ({
    blocks, objectives, isLoading, whenLoaded,
    blockFor, activeBlock, objectiveFor, refresh,
    createBlock, createBlocks, updateBlock, deleteBlock,
    createObjective, updateObjective, deleteObjective,
  }), [
    blocks, objectives, isLoading, whenLoaded, blockFor, activeBlock, objectiveFor, refresh,
    createBlock, createBlocks, updateBlock, deleteBlock, createObjective, updateObjective, deleteObjective,
  ]);

  return <BlocksContext.Provider value={value}>{children}</BlocksContext.Provider>;
}

export function useBlocks(): BlocksContextValue {
  const ctx = useContext(BlocksContext);
  if (!ctx) throw new Error('useBlocks must be used within a BlocksProvider');
  return ctx;
}
