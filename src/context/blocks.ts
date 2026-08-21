import { createContext, useContext } from 'react';
import type { Objective, TrainingBlock } from '../types/blocks';

// Context object + hook live apart from the provider so BlocksContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export interface BlocksSnapshot {
  blocks: TrainingBlock[];
  objectives: Objective[];
}

export interface BlocksContextValue {
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

export const BlocksContext = createContext<BlocksContextValue | null>(null);

export function useBlocks(): BlocksContextValue {
  const ctx = useContext(BlocksContext);
  if (!ctx) throw new Error('useBlocks must be used within a BlocksProvider');
  return ctx;
}
