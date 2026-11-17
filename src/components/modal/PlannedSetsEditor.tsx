import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  BASE_FIELD, TARGET_LABELS, addableFields, inheritedTarget, parseTarget, pyramidSets, rampSets, setCount,
  setTarget, storedSets, tableRows, targetFields, topSetBackoffs, presetOptions, untimedRests,
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

interface Props {
  entry: Exercise;
  /** Writes the whole table (or `undefined` to remove it). */
  onChange: (plannedSets: PlannedSet[] | undefined) => void;
}

/**
 * The "Per-set targets" disclosure on an editor card: one row per set, a
 * column per dimension the prescription names (and any the athlete adds:
 * weight, reps, duration, rest), and three presets that fill the rows (ramp,
 * pyramid, top set + back-offs). Rows stay editable after a preset. Every
 * edit writes `plannedSets` whole; the builders in
 * src/lib/builder/plannedSets.ts do the arithmetic, this only renders.
 *
 * A cell holds an override. An empty one shows the set-level value it
 * follows as its placeholder, so a base edit reaches it; "Remove per-set
 * targets" drops every override on purpose.
 */
export default function PlannedSetsEditor({ entry, onChange }: Props) {
  const authored = !!entry.plannedSets?.length;
  const [open, setOpen] = useState(authored);
  const [preset, setPreset] = useState<Preset | null>(null);
  // Columns added by hand stay until the card unmounts; once a cell in one
  // holds a value, targetFields keeps it on its own.
  const [added, setAdded] = useState<TargetField[]>([]);

  const fields = targetFields(entry, added);
  const addable = addableFields(fields);
  const rows = tableRows(entry);
  const untimed = untimedRests(rows);
  const count = setCount(entry);

  const write = (next: PlannedSet[]) => onChange(storedSets(next));
  const fill = (next: PlannedSet[]) => { write(next); setPreset(null); };

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
                        placeholder={inheritedTarget(entry, f) ?? '—'}
                        aria-label={`Set ${r.setNumber} ${TARGET_LABELS[f].toLowerCase()}`}
                        onChange={e => write(setTarget(rows, r.setNumber, f, e.target.value))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {untimed.length > 0 && (
            <p className="planned-sets__hint" role="note">
              No timer starts for set {untimed.join(', ')}: a rest needs s or min.
            </p>
          )}

          {addable.length > 0 && (
            <div className="planned-sets__add" role="group" aria-label="Add a column">
              {addable.map(f => (
                <button
                  key={f}
                  type="button"
                  className="planned-sets__action planned-sets__action--add"
                  onClick={() => setAdded(a => [...a, f])}
                >
                  + {TARGET_LABELS[f]}
                </button>
              ))}
            </div>
          )}

          {authored && (
            <div className="planned-sets__actions">
              <button
                type="button"
                className="planned-sets__action planned-sets__action--remove"
                onClick={() => { onChange(undefined); setPreset(null); }}
                title="Every set follows the set-level fields again"
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

  const base = entry[BASE_FIELD[field]];
  const first = parseTarget(a);
  const second = parseTarget(b);
  const n = parseInt(backoffs, 10);
  const pct = parseFloat(percent);

  const ready = preset === 'topset'
    ? !!first && Number.isFinite(n) && n >= 0 && Number.isFinite(pct) && pct > 0
    : !!first && !!second;

  const apply = () => {
    if (!ready || !first) return;
    const options = presetOptions(field, a, base);
    if (preset === 'ramp') onFill(rampSets(rows, field, first.value, second!.value, options));
    else if (preset === 'pyramid') onFill(pyramidSets(rows, field, first.value, second!.value, options));
    else onFill(topSetBackoffs(rows, field, first.value, n, pct, options));
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
