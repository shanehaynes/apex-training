import { useState } from 'react';
import { X } from 'lucide-react';
import { addDays, format, parseISO, startOfISOWeek } from 'date-fns';
import { useBlocks } from '../../context/BlocksContext';
import { notify } from '../../lib/notify';
import { BLOCK_PHASES } from '../../types/blocks';
import type { BlockPhase, TrainingBlock, WeeklyTargets } from '../../types/blocks';
import { TARGET_META } from '../../lib/blocks/targets';
import { isValidationError } from '../../lib/blocks/validate';
import { now } from '../../lib/clock';

// Dates are snapped to ISO week boundaries on input, so the user picks any
// day and gets the Monday that contains it — the DB CHECK constraints would
// otherwise reject the write with a raw SQLSTATE.

const toMonday = (date: string) => format(startOfISOWeek(parseISO(date)), 'yyyy-MM-dd');

/** The stored end is exclusive; the field shows the inclusive last day (a Sunday). */
const toInclusiveEnd = (endExclusive: string) => format(addDays(parseISO(endExclusive), -1), 'yyyy-MM-dd');
const toExclusiveEnd = (inclusive: string) => format(addDays(startOfISOWeek(parseISO(inclusive)), 7), 'yyyy-MM-dd');

const numberOrUndefined = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export default function BlockEditor({
  block,
  onClose,
  onSaved,
}: {
  block: TrainingBlock | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { objectives, createBlock, updateBlock, deleteBlock } = useBlocks();
  const defaultStart = format(startOfISOWeek(now()), 'yyyy-MM-dd');

  const [name, setName] = useState(block?.name ?? '');
  const [intent, setIntent] = useState(block?.intent ?? '');
  const [phase, setPhase] = useState<BlockPhase | ''>(block?.phase ?? '');
  const [objectiveId, setObjectiveId] = useState(block?.objectiveId ?? '');
  const [startDate, setStartDate] = useState(block?.startDate ?? defaultStart);
  const [endInclusive, setEndInclusive] = useState(
    block ? toInclusiveEnd(block.endDateExclusive) : format(addDays(parseISO(defaultStart), 27), 'yyyy-MM-dd'),
  );
  const [targets, setTargets] = useState<Record<string, string>>({
    cardioMinutes:      block?.weeklyTargets.cardioMinutes?.toString() ?? '',
    strengthSessions:   block?.weeklyTargets.strengthSessions?.toString() ?? '',
    climbingSessions:   block?.weeklyTargets.climbingSessions?.toString() ?? '',
    longSessionMinutes: block?.weeklyTargets.longSessionMinutes?.toString() ?? '',
    vert:               block?.weeklyTargets.vert?.value.toString() ?? '',
    distance:           block?.weeklyTargets.distance?.value.toString() ?? '',
  });
  const [vertUnit, setVertUnit] = useState<'ft' | 'm'>(block?.weeklyTargets.vert?.unit ?? 'ft');
  const [distanceUnit, setDistanceUnit] = useState<'mi' | 'km'>(block?.weeklyTargets.distance?.unit ?? 'mi');
  const [saving, setSaving] = useState(false);

  const setTarget = (key: string, value: string) => setTargets(t => ({ ...t, [key]: value }));

  function buildTargets(): WeeklyTargets {
    const out: WeeklyTargets = {};
    const cardio = numberOrUndefined(targets.cardioMinutes);
    if (cardio !== undefined) out.cardioMinutes = cardio;
    const strength = numberOrUndefined(targets.strengthSessions);
    if (strength !== undefined) out.strengthSessions = strength;
    const climbing = numberOrUndefined(targets.climbingSessions);
    if (climbing !== undefined) out.climbingSessions = climbing;
    const long = numberOrUndefined(targets.longSessionMinutes);
    if (long !== undefined) out.longSessionMinutes = long;
    const vert = numberOrUndefined(targets.vert);
    if (vert !== undefined) out.vert = { value: vert, unit: vertUnit };
    const distance = numberOrUndefined(targets.distance);
    if (distance !== undefined) out.distance = { value: distance, unit: distanceUnit };
    return out;
  }

  async function save() {
    setSaving(true);
    const input: Omit<TrainingBlock, 'id'> = {
      name: name.trim(),
      intent: intent.trim(),
      phase: phase || undefined,
      objectiveId: objectiveId || undefined,
      startDate: toMonday(startDate),
      endDateExclusive: toExclusiveEnd(endInclusive),
      weeklyTargets: buildTargets(),
    };
    try {
      if (block) await updateBlock(block.id, input);
      else await createBlock(input);
      onSaved();
    } catch (err) {
      // Validation failures are the user's to fix and carry a readable
      // message; transport failures already toasted in src/lib/api.ts.
      if (isValidationError(err)) notify(err.message);
      setSaving(false);
    }
  }

  async function remove() {
    if (!block) return;
    setSaving(true);
    try {
      await deleteBlock(block.id, block.name);
      onSaved();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">{block ? 'Edit block' : 'New block'}</h2>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="block-editor">
        <label className="library-field">
          <span className="library-field__label">Name</span>
          <input
            className="library-field__input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Fall Aerobic Foundation"
          />
        </label>

        <label className="library-field">
          <span className="library-field__label">Intent</span>
          <textarea
            className="library-field__input library-field__input--textarea"
            value={intent}
            onChange={e => setIntent(e.target.value)}
            rows={2}
            placeholder="What this block is for"
          />
        </label>

        <div className="library-field-row">
          <label className="library-field">
            <span className="library-field__label">Phase</span>
            <select className="library-field__input" value={phase} onChange={e => setPhase(e.target.value as BlockPhase | '')}>
              <option value="">—</option>
              {BLOCK_PHASES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          <label className="library-field">
            <span className="library-field__label">Objective</span>
            <select className="library-field__input" value={objectiveId} onChange={e => setObjectiveId(e.target.value)}>
              <option value="">—</option>
              {objectives.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        </div>

        <div className="library-field-row">
          <label className="library-field">
            <span className="library-field__label">Starts (snaps to Monday)</span>
            <input
              className="library-field__input"
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              onBlur={e => setStartDate(toMonday(e.target.value))}
            />
          </label>
          <label className="library-field">
            <span className="library-field__label">Ends (snaps to Sunday)</span>
            <input
              className="library-field__input"
              type="date"
              value={endInclusive}
              onChange={e => setEndInclusive(e.target.value)}
              onBlur={e => setEndInclusive(toInclusiveEnd(toExclusiveEnd(e.target.value)))}
            />
          </label>
        </div>

        <h3 className="block-section__title">
          Weekly targets
          <span className="block-section__sub">leave blank to derive from the calendar</span>
        </h3>

        <div className="block-targets">
          {(['cardioMinutes', 'strengthSessions', 'climbingSessions', 'longSessionMinutes'] as const).map(key => (
            <label key={key} className="library-field">
              <span className="library-field__label">
                {TARGET_META[key].label} <span className="library-field__label-unit">{TARGET_META[key].unit}</span>
              </span>
              <input
                className="library-field__input"
                type="number"
                min="0"
                value={targets[key]}
                onChange={e => setTarget(key, e.target.value)}
              />
            </label>
          ))}

          <label className="library-field">
            <span className="library-field__label">Vertical gain</span>
            <div className="block-combo">
              <input
                className="library-field__input"
                type="number"
                min="0"
                value={targets.vert}
                onChange={e => setTarget('vert', e.target.value)}
              />
              <select className="library-field__input block-field__unit-select" value={vertUnit} onChange={e => setVertUnit(e.target.value as 'ft' | 'm')}>
                <option value="ft">ft</option>
                <option value="m">m</option>
              </select>
            </div>
          </label>

          <label className="library-field">
            <span className="library-field__label">Distance</span>
            <div className="block-combo">
              <input
                className="library-field__input"
                type="number"
                min="0"
                value={targets.distance}
                onChange={e => setTarget('distance', e.target.value)}
              />
              <select className="library-field__input block-field__unit-select" value={distanceUnit} onChange={e => setDistanceUnit(e.target.value as 'mi' | 'km')}>
                <option value="mi">mi</option>
                <option value="km">km</option>
              </select>
            </div>
          </label>
        </div>

        <div className="library-editor__actions block-editor__actions">
          <button className="library-editor__save" onClick={save} disabled={saving || !name.trim()}>
            {block ? 'Save' : 'Create block'}
          </button>
          {block && (
            <button className="library-editor__archive" onClick={remove} disabled={saving}>Delete</button>
          )}
          <button className="library-editor__cancel" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
