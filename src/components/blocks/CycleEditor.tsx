import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { format, parseISO, startOfISOWeek } from 'date-fns';
import { useBlocks } from '../../context/blocks';
import { notify } from '../../lib/notify';
import { OBJECTIVE_DISCIPLINES } from '../../types/blocks';
import type { ObjectiveDiscipline, TrainingBlock, WeeklyTargets } from '../../types/blocks';
import { TARGET_META } from '../../lib/blocks/targets';
import { isValidationError } from '../../lib/blocks/validate';
import { blockWeeks } from '../../lib/blocks/period';
import {
  DEFAULT_CYCLES,
  DEFAULT_RECOVERY_SCALE,
  DEFAULT_WEEKS_OFF,
  DEFAULT_WEEKS_ON,
  cycleTotalWeeks,
  generateCycle,
  isCycleSpecError,
  overlapsExisting,
} from '../../lib/blocks/cadence';
import { now } from '../../lib/clock';

// The multi-block editor: one form that lays down a whole periodized cycle.
// Everything it emits is an ordinary TrainingBlock — see the header of
// src/lib/blocks/cadence.ts for why a cycle isn't its own stored entity.
//
// The preview below the form is the point of the screen: 3-on/1-off is a
// rhythm, and a list of dated blocks is the only way to see it before it
// exists.

const toMonday = (date: string) => format(startOfISOWeek(parseISO(date)), 'yyyy-MM-dd');

const numberOrUndefined = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const intOr = (value: string, fallback: number): number => {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const RECOVERY_SCALES = [
  { value: 0.4, label: '40% — a real rest week' },
  { value: 0.5, label: '50% — half volume' },
  { value: 0.6, label: '60% — a light week' },
];

const shortRange = (block: Pick<TrainingBlock, 'startDate' | 'endDateExclusive'>) => {
  const start = parseISO(block.startDate);
  const lastDay = parseISO(block.endDateExclusive);
  return `${format(start, 'MMM d')} – ${format(lastDay, 'MMM d')}`;
};

export default function CycleEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { blocks, objectives, createBlocks, createObjective } = useBlocks();
  const defaultStart = format(startOfISOWeek(now()), 'yyyy-MM-dd');

  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [objectiveId, setObjectiveId] = useState('');
  const [startDate, setStartDate] = useState(defaultStart);
  const [weeksOn, setWeeksOn] = useState(String(DEFAULT_WEEKS_ON));
  const [weeksOff, setWeeksOff] = useState(String(DEFAULT_WEEKS_OFF));
  const [cycles, setCycles] = useState(String(DEFAULT_CYCLES));
  const [recoveryScale, setRecoveryScale] = useState(DEFAULT_RECOVERY_SCALE);
  const [targets, setTargets] = useState<Record<string, string>>({
    cardioMinutes: '', strengthSessions: '', climbingSessions: '',
    longSessionMinutes: '', vert: '', distance: '',
  });
  const [vertUnit, setVertUnit] = useState<'ft' | 'm'>('ft');
  const [distanceUnit, setDistanceUnit] = useState<'mi' | 'km'>('mi');
  const [saving, setSaving] = useState(false);

  // Inline objective creation. The select is otherwise permanently empty for
  // a new account — nothing else in the app creates an objective.
  const [addingObjective, setAddingObjective] = useState(false);
  const [objectiveName, setObjectiveName] = useState('');
  const [objectiveDate, setObjectiveDate] = useState('');
  const [objectiveDiscipline, setObjectiveDiscipline] = useState<ObjectiveDiscipline | ''>('');

  const setTarget = (key: string, value: string) => setTargets(t => ({ ...t, [key]: value }));

  const weeklyTargets = useMemo<WeeklyTargets>(() => {
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
  }, [targets, vertUnit, distanceUnit]);

  const spec = useMemo(() => ({
    startDate,
    weeksOn: intOr(weeksOn, DEFAULT_WEEKS_ON),
    weeksOff: intOr(weeksOff, DEFAULT_WEEKS_OFF),
    cycles: intOr(cycles, DEFAULT_CYCLES),
    namePrefix: name.trim() || 'Cycle',
    intent,
    objectiveId,
    weeklyTargets,
    recoveryScale,
  }), [startDate, weeksOn, weeksOff, cycles, name, intent, objectiveId, weeklyTargets, recoveryScale]);

  // The preview doubles as validation: a spec that can't generate shows its
  // reason here rather than failing only on submit.
  const preview = useMemo(() => {
    try {
      return { blocks: generateCycle(spec), error: null as string | null };
    } catch (err) {
      return { blocks: [], error: err instanceof Error ? err.message : 'That cycle can’t be built' };
    }
  }, [spec]);

  const conflict = useMemo(
    () => (preview.blocks.length ? overlapsExisting(preview.blocks, blocks) : null),
    [preview.blocks, blocks],
  );

  const totalWeeks = cycleTotalWeeks(spec);
  const canSave = !!name.trim() && preview.blocks.length > 0 && !preview.error && !conflict && !saving;

  async function addObjective() {
    const trimmed = objectiveName.trim();
    if (!trimmed) return;
    const created = await createObjective({
      name: trimmed,
      targetDate: objectiveDate || undefined,
      discipline: objectiveDiscipline || undefined,
      notes: '',
      status: 'active',
    });
    if (created) {
      setObjectiveId(created.id);
      setAddingObjective(false);
      setObjectiveName('');
      setObjectiveDate('');
      setObjectiveDiscipline('');
    }
  }

  async function save() {
    setSaving(true);
    try {
      await createBlocks(generateCycle(spec));
      notify(`Added ${preview.blocks.length} blocks — ${totalWeeks} weeks`);
      onSaved();
    } catch (err) {
      // Spec and block validation carry readable messages; transport failures
      // already toasted in src/lib/api.ts.
      if (isCycleSpecError(err) || isValidationError(err)) notify(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">New cycle</h2>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="block-editor">
        <p className="block-empty">
          A cycle repeats weeks of work followed by an easier week — enough load to adapt,
          enough rest to absorb it. It lays down ordinary blocks you can edit afterward.
        </p>

        <label className="library-field">
          <span className="library-field__label">Name</span>
          <input
            className="library-field__input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Spring Alpine"
          />
        </label>

        <label className="library-field">
          <span className="library-field__label">Intent</span>
          <textarea
            className="library-field__input library-field__input--textarea"
            value={intent}
            onChange={e => setIntent(e.target.value)}
            rows={2}
            placeholder="What this cycle is for"
          />
        </label>

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
            <span className="library-field__label">Objective</span>
            <select
              className="library-field__input"
              value={objectiveId}
              onChange={e => setObjectiveId(e.target.value)}
            >
              <option value="">—</option>
              {objectives.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        </div>

        {addingObjective ? (
          <div className="cycle-objective-new">
            <div className="library-field-row">
              <label className="library-field">
                <span className="library-field__label">Objective</span>
                <input
                  className="library-field__input"
                  value={objectiveName}
                  onChange={e => setObjectiveName(e.target.value)}
                  placeholder="Summit Rainier"
                />
              </label>
              <label className="library-field">
                <span className="library-field__label">Target date</span>
                <input
                  className="library-field__input"
                  type="date"
                  value={objectiveDate}
                  onChange={e => setObjectiveDate(e.target.value)}
                />
              </label>
              <label className="library-field">
                <span className="library-field__label">Discipline</span>
                <select
                  className="library-field__input"
                  value={objectiveDiscipline}
                  onChange={e => setObjectiveDiscipline(e.target.value as ObjectiveDiscipline | '')}
                >
                  <option value="">—</option>
                  {OBJECTIVE_DISCIPLINES.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
            <div className="cycle-objective-new__actions">
              <button className="library-editor__save" onClick={addObjective} disabled={!objectiveName.trim()}>
                Add objective
              </button>
              <button className="library-editor__cancel" onClick={() => setAddingObjective(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="cycle-objective-add" onClick={() => setAddingObjective(true)}>
            <Plus size={13} strokeWidth={1.5} /> New objective
          </button>
        )}

        <h3 className="block-section__title">
          Cadence
          <span className="block-section__sub">three on, one off by default</span>
        </h3>

        <div className="cycle-cadence">
          <label className="library-field">
            <span className="library-field__label">Weeks on</span>
            <input
              className="library-field__input"
              type="number" min="1" max="52"
              value={weeksOn}
              onChange={e => setWeeksOn(e.target.value)}
            />
          </label>
          <label className="library-field">
            <span className="library-field__label">Weeks off</span>
            <input
              className="library-field__input"
              type="number" min="0" max="52"
              value={weeksOff}
              onChange={e => setWeeksOff(e.target.value)}
            />
          </label>
          <label className="library-field">
            <span className="library-field__label">Repeat</span>
            <input
              className="library-field__input"
              type="number" min="1" max="12"
              value={cycles}
              onChange={e => setCycles(e.target.value)}
            />
          </label>
          <label className="library-field">
            <span className="library-field__label">Recovery volume</span>
            <select
              className="library-field__input"
              value={recoveryScale}
              onChange={e => setRecoveryScale(Number(e.target.value))}
              disabled={intOr(weeksOff, DEFAULT_WEEKS_OFF) === 0}
            >
              {RECOVERY_SCALES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>

        <h3 className="block-section__title">
          Weekly targets
          <span className="block-section__sub">for the working weeks — leave blank to derive from the calendar</span>
        </h3>

        <div className="block-targets">
          {(['cardioMinutes', 'strengthSessions', 'climbingSessions', 'longSessionMinutes'] as const).map(key => (
            <label key={key} className="library-field">
              <span className="library-field__label">
                {TARGET_META[key].label} <span className="library-field__label-unit">{TARGET_META[key].unit}</span>
              </span>
              <input
                className="library-field__input"
                type="number" min="0"
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
                type="number" min="0"
                value={targets.vert}
                onChange={e => setTarget('vert', e.target.value)}
              />
              <select
                className="library-field__input block-field__unit-select"
                value={vertUnit}
                onChange={e => setVertUnit(e.target.value as 'ft' | 'm')}
              >
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
                type="number" min="0"
                value={targets.distance}
                onChange={e => setTarget('distance', e.target.value)}
              />
              <select
                className="library-field__input block-field__unit-select"
                value={distanceUnit}
                onChange={e => setDistanceUnit(e.target.value as 'mi' | 'km')}
              >
                <option value="mi">mi</option>
                <option value="km">km</option>
              </select>
            </div>
          </label>
        </div>

        <h3 className="block-section__title">
          Preview
          {preview.blocks.length > 0 && (
            <span className="block-section__sub">
              {preview.blocks.length} blocks · {totalWeeks} weeks ·{' '}
              {format(parseISO(preview.blocks[0].startDate), 'MMM d')} –{' '}
              {format(parseISO(preview.blocks[preview.blocks.length - 1].endDateExclusive), 'MMM d, yyyy')}
            </span>
          )}
        </h3>

        <div className="cycle-preview">
          {preview.error && <p className="cycle-preview__error">{preview.error}</p>}

          {conflict && (
            <p className="cycle-preview__error">
              This overlaps “{conflict.name}” ({shortRange(conflict)}). Move the start date, or shorten the cycle.
            </p>
          )}

          {preview.blocks.map(block => (
            <div key={block.startDate} className={`cycle-preview__row cycle-preview__row--${block.phase}`}>
              <span className="cycle-preview__phase">{block.phase}</span>
              <span className="cycle-preview__name">{block.name}</span>
              <span className="cycle-preview__range">{shortRange(block)}</span>
              <span className="cycle-preview__weeks">
                {blockWeeks(block)}w
              </span>
            </div>
          ))}
        </div>

        <div className="library-editor__actions block-editor__actions">
          <button className="library-editor__save" onClick={save} disabled={!canSave}>
            {saving ? 'Creating…' : `Create ${preview.blocks.length || ''} blocks`.trim()}
          </button>
          <button className="library-editor__cancel" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
