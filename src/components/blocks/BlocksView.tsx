import { useEffect, useState } from 'react';
import { useModalChrome } from '../../hooks/useModalChrome';
import { ChevronRight, Plus, Repeat, Target, X } from 'lucide-react';
import { useCalendar } from '../../context/CalendarContext';
import { useBlocks } from '../../context/BlocksContext';
import { blockPeriod, blockWeeks, currentWeekIndex } from '../../lib/blocks/period';
import { now } from '../../lib/clock';
import type { TrainingBlock } from '../../types/blocks';
import BlockDetail from './BlockDetail';
import BlockEditor from './BlockEditor';
import CycleEditor from './CycleEditor';

type Mode =
  | { kind: 'list' }
  | { kind: 'detail'; block: TrainingBlock }
  | { kind: 'edit'; block: TrainingBlock | null }
  | { kind: 'cycle' };

export default function BlocksView() {
  const { dispatch } = useCalendar();
  const { blocks, objectives, isLoading, objectiveFor } = useBlocks();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const close = () => dispatch({ type: 'CLOSE_BLOCKS' });


  useModalChrome(close);

  // The list re-reads from context after a write, so a deleted or renamed
  // block can't leave a stale detail view mounted.
  useEffect(() => {
    if (mode.kind === 'detail' && !blocks.some(b => b.id === mode.block.id)) {
      setMode({ kind: 'list' });
    }
  }, [blocks, mode]);

  if (mode.kind === 'cycle') {
    return (
      <CycleEditor
        onClose={() => setMode({ kind: 'list' })}
        onSaved={() => setMode({ kind: 'list' })}
      />
    );
  }

  if (mode.kind === 'edit') {
    return (
      <BlockEditor
        block={mode.block}
        onClose={() => setMode({ kind: 'list' })}
        onSaved={() => setMode({ kind: 'list' })}
      />
    );
  }

  if (mode.kind === 'detail') {
    const live = blocks.find(b => b.id === mode.block.id) ?? mode.block;
    return (
      <BlockDetail
        block={live}
        onBack={() => setMode({ kind: 'list' })}
        onClose={close}
        onEdit={() => setMode({ kind: 'edit', block: live })}
      />
    );
  }

  const today = now();

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">Training blocks</h2>
          <span className="library-header__count">{blocks.length}</span>
        </div>
        <div className="library-header__actions">
          <button
            className="library-edit-btn"
            data-testid="new-cycle"
            onClick={() => setMode({ kind: 'cycle' })}
            title="Lay down a repeating build/recovery cycle"
          >
            <Repeat size={14} strokeWidth={1.5} /> New cycle
          </button>
          <button
            className="library-edit-btn"
            onClick={() => setMode({ kind: 'edit', block: null })}
          >
            <Plus size={14} strokeWidth={1.5} /> New block
          </button>
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>


      <div className="block-list">
        {isLoading && <p className="block-empty" aria-busy="true">Loading…</p>}

        {!isLoading && blocks.length === 0 && (
          <p className="block-empty">
            No training blocks yet. A block is a dated stretch of training with weekly targets —
            it's what lets the coach say “92% of planned aerobic volume” instead of “7 hours.”
            Start with a cycle: three weeks of work, one easier week, repeated.
          </p>
        )}

        {blocks.map(block => {
          const week = currentWeekIndex(block, today);
          const objective = objectiveFor(block);
          return (
            <button
              key={block.id}
              className={`block-row ${week ? 'block-row--active' : ''}`}
              onClick={() => setMode({ kind: 'detail', block })}
            >
              <div className="block-row__main">
                <span className="block-row__name">{block.name}</span>
                <span className="block-row__meta">
                  {blockPeriod(block).label}
                  {block.phase && <> · {block.phase}</>}
                  {objective && <> · {objective.name}</>}
                </span>
              </div>
              <span className="block-row__week">
                {week ? `week ${week} of ${blockWeeks(block)}` : `${blockWeeks(block)} weeks`}
              </span>
              <ChevronRight size={16} strokeWidth={1.5} className="block-row__chevron" />
            </button>
          );
        })}

        {objectives.length > 0 && (
          <section className="block-objectives">
            <h3 className="block-section__title">
              <Target size={14} strokeWidth={1.5} /> Objectives
            </h3>
            <ul className="block-objectives__list">
              {objectives.map(o => (
                <li key={o.id}>
                  <span className="block-objectives__name">{o.name}</span>
                  {o.targetDate && <span className="block-objectives__date">{o.targetDate}</span>}
                  {o.discipline && <span className="block-objectives__tag">{o.discipline}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
