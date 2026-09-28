import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useBlocks } from '../../context/blocks';
import { notify } from '../../lib/notify';
import { blockPeriod, blockWeeks } from '../../lib/blocks/period';
import { TARGET_META, WEEKLY_TARGET_KEYS, targetUnit, targetValue } from '../../lib/blocks/targets';
import { isValidationError } from '../../lib/blocks/validate';
import { draftFromBlock, emptyBlockDraft, type BlockDraft, type BlockDraftItem } from '../../lib/blocks/draft';
import { now } from '../../lib/clock';
import type { Objective, TrainingBlock } from '../../types/blocks';
import BlockPlannerPanel from './BlockPlannerPanel';
import './block-planner.css';

// "Plan with the coach" (coach initiative E01, decision D-C07): the block
// draft the user owns, one card per block, beside the planner's coach
// thread. The coach's only write reduces onto this draft; nothing persists
// until the user presses Apply, which calls the same createBlocks (atomic,
// ≤ 24) / updateBlock the cycle generator and the block editor call, with
// triggered_by 'user'. Cancel discards the draft.

export default function BlockPlanner({
  editingId,
  onClose,
  onApplied,
}: {
  /** The block the planner replaces when opened from its detail; null to plan new blocks. */
  editingId: string | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { blocks, objectives, createBlocks, updateBlock, refresh } = useBlocks();
  const today = useMemo(() => now(), []);
  const editing = editingId ? blocks.find(b => b.id === editingId) ?? null : null;
  const [draft, setDraft] = useState<BlockDraft>(() => (editing ? draftFromBlock(editing) : emptyBlockDraft(today)));
  const [applying, setApplying] = useState(false);

  // What the reducer checks the coach's proposals against — memoized so the
  // panel's ref effect only re-runs when the underlying lists change.
  const ctx = useMemo(() => ({ existing: blocks, objectives, today }), [blocks, objectives, today]);

  const remove = (index: number) =>
    setDraft(d => ({ ...d, blocks: d.blocks.filter((_, i) => i !== index) }));

  async function apply() {
    if (draft.blocks.length === 0) return;
    setApplying(true);
    try {
      if (draft.editingId) await updateBlock(draft.editingId, editFields(draft.blocks[0]));
      else await createBlocks(draft.blocks);
      await refresh();
      onApplied();
    } catch (err) {
      // Validation failures are the user's to fix and carry a readable
      // message; transport failures already toasted in src/lib/api.ts.
      if (isValidationError(err)) notify(err.message);
      setApplying(false);
    }
  }

  const count = draft.blocks.length;
  const applyLabel = draft.editingId
    ? 'Apply changes'
    : count === 1 ? 'Apply 1 block' : `Apply ${count} blocks`;

  return (
    <div className="library-view" data-testid="block-planner">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">Plan with the coach</h2>
          <span className="library-header__count">
            {editing ? `editing ${editing.name}` : `${count} ${count === 1 ? 'block' : 'blocks'} drafted`}
          </span>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="block-planner">
        <div className="block-planner__draft" data-testid="block-draft">
          <p className="block-planner__intro">
            The coach drafts here; you decide. Nothing is created until you press Apply.
          </p>

          {count === 0 ? (
            <DraftEmpty editing={!!editing} />
          ) : (
            draft.blocks.map((block, i) => (
              <DraftCard
                key={`${block.startDate}-${i}`}
                index={i}
                block={block}
                objective={objectives.find(o => o.id === block.objectiveId) ?? null}
                onRemove={() => remove(i)}
              />
            ))
          )}

          <div className="library-editor__actions block-planner__actions">
            <button
              className="library-editor__save"
              data-testid="block-planner-apply"
              onClick={apply}
              disabled={applying || count === 0}
            >
              {applyLabel}
            </button>
            <button className="library-editor__cancel" onClick={onClose} disabled={applying}>Cancel</button>
          </div>
        </div>

        <BlockPlannerPanel draft={draft} setDraft={setDraft} ctx={ctx} />
      </div>
    </div>
  );
}

/**
 * The PATCH for a redrawn block. blockFieldsToRow skips `undefined` fields,
 * so an item with no phase or objective would leave the old ones in place;
 * an explicit null is what clears a column (the row types are nullable, the
 * domain type is not — hence the cast).
 */
export function editFields(item: BlockDraftItem): Partial<Omit<TrainingBlock, 'id'>> {
  return {
    ...item,
    phase: item.phase ?? null,
    objectiveId: item.objectiveId ?? null,
  } as unknown as Partial<Omit<TrainingBlock, 'id'>>;
}

// ─── Presentational pieces (tested at the markup level) ──────────────────────

export function DraftEmpty({ editing }: { editing: boolean }) {
  return (
    <p className="block-planner__empty" data-testid="block-draft-empty">
      {editing
        ? 'The draft is empty — ask the coach to redraw this block, or Cancel to keep it as it is.'
        : 'No blocks drafted yet. Tell the coach what you are training for and when — “12 weeks to Denali, base → build → peak → taper” — and the plan appears here, one card per block.'}
    </p>
  );
}

export function DraftCard({
  index,
  block,
  objective,
  onRemove,
}: {
  index: number;
  block: BlockDraftItem;
  objective: Objective | null;
  onRemove: () => void;
}) {
  const weeks = blockWeeks(block);
  const range = blockPeriod({ id: `draft-${index}`, ...block }).label;
  const targets = WEEKLY_TARGET_KEYS
    .map(key => {
      const value = targetValue(block.weeklyTargets, key);
      if (value === undefined) return null;
      const unit = targetUnit(block.weeklyTargets, key);
      return { key, label: TARGET_META[key].label, text: `${value.toLocaleString('en-US')}${unit ? ` ${unit}` : ''}` };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  return (
    <article
      className={`block-planner__card${block.phase ? ` block-planner__card--${block.phase}` : ''}`}
      data-testid="block-draft-card"
    >
      <div className="block-planner__card-head">
        <span className="block-planner__index">{index + 1}</span>
        <span className="block-planner__name">{block.name}</span>
        {block.phase && <span className="block-planner__phase">{block.phase}</span>}
        <button className="block-planner__remove" onClick={onRemove} aria-label={`Remove ${block.name} from the draft`} title="Remove from the draft">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="block-planner__range">
        {range} · {weeks} {weeks === 1 ? 'week' : 'weeks'}
      </div>
      {block.intent && <p className="block-planner__intent">{block.intent}</p>}
      {targets.length > 0 && (
        <dl className="block-planner__targets">
          {targets.map(t => (
            <div key={t.key}>
              <dt>{t.label}</dt>
              <dd>{t.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {objective && <div className="block-planner__objective">Objective: {objective.name}</div>}
    </article>
  );
}
