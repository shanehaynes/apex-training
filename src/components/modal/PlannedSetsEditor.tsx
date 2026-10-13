import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  TARGET_LABELS, parseTarget, pyramidSets, rampSets, setCount, setTarget, tableRows, targetFields,
  topSetBackoffs, uniformSets, unitFor,
} from '../../lib/builder/plannedSets';
import type { TargetField } from '../../lib/builder/plannedSets';
import type { Exercise, PlannedSet } from '../../types/workout';
import '../../styles/planned-sets.css';

type Preset = 'ramp' | 'pyramid' | 'topset';

const PRESET_LABELS: Record<Preset, string> = {
  ramp: 'Ramp',
  pyramid: 'Pyramid',
  topset: 'Top set + back-offs',
};

/** Which base field a target column mirrors, for the unit a preset inherits. */
const BASE_OF: Record<TargetField, 'weight' | 'reps' | 'duration'> = {
  targetWeight: 'weight',
  targetReps: 'reps',
  targetDuration: 'duration',
};

interface Props {
  entry: Exercise;
  /** Writes the whole table (or `undefined` to remove it). */
  onChange: (plannedSets: PlannedSet[] | undefined) => void;
}

/**
 * The "Per-set targets" disclosure on an editor card: one row per set, a
 * column per dimension the prescription names, and three presets that fill
 * the rows (ramp, pyramid, top set + back-offs). Rows stay editable after a
 * preset. Every edit writes `plannedSets` whole; the builders in
 * src/lib/builder/plannedSets.ts do the arithmetic, this only renders.
 *
 * Editing the base prescription no longer clears the table — "Apply to all
 * sets" refills it from the base on purpose, and "Remove per-set targets"
 * drops it on purpose.
 */
export default function PlannedSetsEditor({ entry, onChange }: Props) {
  const authored = !!entry.plannedSets?.length;
  const [open, setOpen] = useState(authored);
  const [preset, setPreset] = useState<Preset | null>(null);

  const fields = targetFields(entry);
  const rows = tableRows(entry);
  const count = setCount(entry);

  const fill = (next: PlannedSet[]) => { onChange(next); setPreset(null); };

  return (
    <div className={`planned-sets${authored ? ' planned-sets--authored' : ''}`}>
      <button
        type="button"
        className="planned-sets__toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <ChevronRight size={12} strokeWidth={2} className="planned-sets__chevron" />
        Per-set targets
        {authored && <span className="planned-sets__badge">{count} {count === 1 ? 'set' : 'sets'} authored</span>}
      </button>

      {open && (
        <div className="planned-sets__body">
          <div className="planned-sets__presets" role="group" aria-label="Presets">
            {(Object.keys(PRESET_LABELS) as Preset[]).map(p => (
              <button
                key={p}
                type="button"
                className={`planned-sets__preset${preset === p ? ' planned-sets__preset--on' : ''}`}
                onClick={() => setPreset(preset === p ? null : p)}
                aria-pressed={preset === p}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          {preset && (
            <PresetForm
              key={preset}
              preset={preset}
              fields={fields}
              entry={entry}
              rows={rows}
              onFill={fill}
              onCancel={() => setPreset(null)}
            />
          )}

          <table className="planned-sets__table">
            <thead>
              <tr>
                <th scope="col">Set</th>
                {fields.map(f => <th key={f} scope="col">{TARGET_LABELS[f]}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.setNumber} className="planned-sets__row">
                  <th scope="row">{r.setNumber}</th>
                  {fields.map(f => (
                    <td key={f}>
                      <input
                        value={r[f] ?? ''}
                        aria-label={`Set ${r.setNumber} ${TARGET_LABELS[f].toLowerCase()}`}
                        onChange={e => onChange(setTarget(rows, r.setNumber, f, e.target.value))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {authored && (
            <div className="planned-sets__actions">
              <button
                type="button"
                className="planned-sets__action"
                onClick={() => onChange(uniformSets(count, entry))}
                title="Every set gets the base weight, reps and duration"
              >
                Apply to all sets
              </button>
              <button
                type="button"
                className="planned-sets__action planned-sets__action--remove"
                onClick={() => { onChange(undefined); setPreset(null); }}
              >
                Remove per-set targets
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PresetForm({
  preset, fields, entry, rows, onFill, onCancel,
}: {
  preset: Preset;
  fields: TargetField[];
  entry: Exercise;
  rows: PlannedSet[];
  onFill: (rows: PlannedSet[]) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState<TargetField>(fields[0]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [backoffs, setBackoffs] = useState(String(Math.max(0, rows.length - 1)));
  const [percent, setPercent] = useState('80');

  const base = entry[BASE_OF[field]];
  const first = parseTarget(a);
  const second = parseTarget(b);
  const n = parseInt(backoffs, 10);
  const pct = parseFloat(percent);

  const ready = preset === 'topset'
    ? !!first && Number.isFinite(n) && n >= 0 && Number.isFinite(pct) && pct > 0
    : !!first && !!second;

  const apply = () => {
    if (!ready || !first) return;
    const unit = unitFor(a, base);
    if (preset === 'ramp') onFill(rampSets(rows, field, first.value, second!.value, { unit }));
    else if (preset === 'pyramid') onFill(pyramidSets(rows, field, first.value, second!.value, { unit }));
    else onFill(topSetBackoffs(rows, field, first.value, n, pct, { unit }));
  };

  const placeholder = base && parseTarget(base) ? base : TARGET_LABELS[field].toLowerCase();

  return (
    <form
      className="planned-sets__form"
      onSubmit={e => { e.preventDefault(); apply(); }}
      aria-label={`${PRESET_LABELS[preset]} preset`}
    >
      {fields.length > 1 && (
        <label className="planned-sets__input">
          <span>Field</span>
          <select value={field} onChange={e => setField(e.target.value as TargetField)}>
            {fields.map(f => <option key={f} value={f}>{TARGET_LABELS[f]}</option>)}
          </select>
        </label>
      )}
      <label className="planned-sets__input">
        <span>{preset === 'ramp' ? 'First' : preset === 'pyramid' ? 'Start' : 'Top'}</span>
        <input value={a} placeholder={placeholder} onChange={e => setA(e.target.value)} autoFocus />
      </label>
      {preset === 'topset' ? (
        <>
          <label className="planned-sets__input planned-sets__input--narrow">
            <span>Back-offs</span>
            <input inputMode="numeric" value={backoffs} onChange={e => setBackoffs(e.target.value)} />
          </label>
          <label className="planned-sets__input planned-sets__input--narrow">
            <span>At %</span>
            <input inputMode="decimal" value={percent} onChange={e => setPercent(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="planned-sets__input">
          <span>{preset === 'ramp' ? 'Last' : 'Peak'}</span>
          <input value={b} placeholder={placeholder} onChange={e => setB(e.target.value)} />
        </label>
      )}
      <div className="planned-sets__form-actions">
        <button type="submit" className="planned-sets__fill" disabled={!ready}>Fill</button>
        <button type="button" className="planned-sets__action" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
