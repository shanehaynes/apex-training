import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, Sparkles, X } from 'lucide-react';
import { notify } from '../../lib/notify';
import { useAnalytics, type TileView } from '../../context/analytics';
import { BUILDER_DEBOUNCE_MS, useTileResults } from '../../hooks/useTileResults';
import {
  MEASURES,
  WORKOUT_TYPES,
  sportCompatible,
  type Aggregation,
  type GroupBy,
} from '../../lib/analytics/spec';
import {
  emptyChartDraft,
  emptySeriesDraft,
  nextSeriesId,
  specFromDraft,
  type ChartDraft,
  type SeriesDraft,
} from '../../lib/analytics/draft';
import { mintTileId, type TileLayout } from '../../lib/analytics/tiles';
import {
  BUCKETS,
  CHART_TYPES,
  DISPLAY_UNITS,
  GRADE_SCALES,
  GROUP_BY_LABELS,
  MEAL_TYPES,
  MEASURE_GROUPS,
  OTHER_SPORT_HINT,
  PRESETS,
  SPORT_OPTIONS,
} from '../../lib/analytics/labels';
import TileRenderer from './TileRenderer';
import AnalyticsCoachPanel from './AnalyticsCoachPanel';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import type { WorkoutType } from '../../types/workout';

// The tile editor: config column on the left, live preview on the right —
// the builder-view two-column pattern. All state is ONE ChartDraft (the
// src/lib/builder/draft.ts doctrine: plain object, numeric fields as
// strings, pure converters); every input writes here, and since #152 the
// draft is also exactly what goes on the wire — the preview posts it to
// /api/analytics-compute and Save posts it to /api/analytics-tiles, so what
// you see is what the server built and persisted, with no client-side spec
// in between. The analytics coach reduces onto the same object via
// applyChartDraftUpdate.

interface Props {
  tile: TileView | null;
  onClose: () => void;
}


function Chips<T extends string>({ label, options, value, onSelect, clearable }: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T | '';
  onSelect: (value: T | '') => void;
  /** Adds an "Auto"/none chip that maps to ''. */
  clearable?: string;
}) {
  return (
    <div className="an-field">
      <span className="an-field__label">{label}</span>
      <div className="an-chips" role="radiogroup" aria-label={label}>
        {clearable !== undefined && (
          <button
            role="radio"
            aria-checked={value === ''}
            className={`an-chip${value === '' ? ' an-chip--active' : ''}`}
            onClick={() => onSelect('')}
          >
            {clearable}
          </button>
        )}
        {options.map(o => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            className={`an-chip${value === o.value ? ' an-chip--active' : ''}`}
            onClick={() => onSelect(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiChips<T extends string>({ label, options, values, onToggle, colorFor, dimmed, dimReason }: {
  label: string;
  options: Array<{ value: T; label: string }>;
  values: T[];
  onToggle: (value: T) => void;
  colorFor?: (value: T) => string | undefined;
  /** Incompatible with a prior selection: rendered dimmed, click is a no-op. */
  dimmed?: (value: T) => boolean;
  dimReason?: string;
}) {
  return (
    <div className="an-field">
      <span className="an-field__label">{label}</span>
      <div className="an-chips" aria-label={label}>
        {options.map(o => {
          const active = values.includes(o.value);
          const off = !active && (dimmed?.(o.value) ?? false);
          const color = active ? colorFor?.(o.value) : undefined;
          return (
            <button
              key={o.value}
              aria-pressed={active}
              aria-disabled={off}
              title={off ? dimReason : undefined}
              className={`an-chip${active ? ' an-chip--active' : ''}${off ? ' an-chip--dimmed' : ''}`}
              style={color ? { borderColor: color, color } : undefined}
              onClick={() => { if (!off) onToggle(o.value); }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const toggle = <T,>(list: T[], value: T): T[] =>
  list.includes(value) ? list.filter(v => v !== value) : [...list, value];

const TYPE_OPTIONS = WORKOUT_TYPES.map(t => ({ value: t, label: WORKOUT_COLORS[t].label }));

export default function TileBuilder({ tile, onClose }: Props) {
  const { tiles, options, saveTile } = useAnalytics();
  // The stored draft comes from the GET (draftFromSpec, run server-side).
  const [draft, setDraft] = useState<ChartDraft>(() => tile?.draft ?? emptyChartDraft());
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [coachOpen, setCoachOpen] = useState(false);

  // The live preview is the compute endpoint with one draft: the server runs
  // specFromDraft and answers a draft the web would refuse with the very
  // same chartDraftProblem text, so the refusal under the form is now the
  // server's word. specFromDraft still runs here, but only to hand
  // TileRenderer a spec to draw against — every NUMBER came from the server.
  const previewRequests = useMemo(() => [{ key: 'preview', draft }], [draft]);
  const preview = useTileResults(previewRequests, BUILDER_DEBOUNCE_MS).preview;
  const built = useMemo(() => specFromDraft(draft), [draft]);
  const problem = preview && !preview.ok ? preview.problem : null;

  const patchSeries = (id: string, patch: Partial<SeriesDraft>) =>
    setDraft(d => ({ ...d, series: d.series.map(s => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSeries = () =>
    setDraft(d => ({ ...d, series: [...d.series, emptySeriesDraft(nextSeriesId(d))] }));

  const removeSeries = (id: string) =>
    setDraft(d => ({ ...d, series: d.series.filter(s => s.id !== id) }));

  // Both pickers arrive with the tiles GET now: 'Other' narrows to the
  // user's own sport='other' workout titles, and the category chips to their
  // exercise categories — neither is derivable in the browser any more,
  // because the browser no longer holds the rows.
  const otherWorkoutOptions = useMemo(
    () => options.otherWorkoutTitles.map(t => ({ value: t, label: t })),
    [options.otherWorkoutTitles],
  );
  const categoryOptions = useMemo(
    () => options.categories.map(v => ({ value: v, label: v })),
    [options.categories],
  );

  // No pre-flight check of our own: the server owns the refusals, and it
  // tests the blank title BEFORE trying to build the draft — the opposite of
  // the order this component used to apply, so an untitled invalid draft now
  // hears about its title first.
  const save = async () => {
    const layout: TileLayout = tile
      ? tile.layout
      : { x: 0, y: tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0), w: 6, h: 4 };
    setSaving(true);
    const result = await saveTile(tile?.id ?? mintTileId(), draft, layout);
    setSaving(false);
    if (!result) return;                 // the request itself failed; lib/api toasted it
    if (!result.ok) {
      // Stay open: the fix is one edit away, and closing would lose it.
      setSaveProblem(result.problem);
      notify(result.problem);
      return;
    }
    setSaveProblem(null);
    notify(tile ? 'Tile updated' : 'Tile added');
    onClose();
  };

  return (
    <div className="tile-builder">
      <div className="tile-builder__config">
        <div className="tile-builder__head">
          <button className="library-back" onClick={onClose} aria-label="Back to dashboard">
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <h2 className="tile-builder__heading">{tile ? 'Edit tile' : 'New tile'}</h2>
          <button
            className="library-edit-btn tile-builder__coach-toggle"
            onClick={() => setCoachOpen(v => !v)}
            aria-pressed={coachOpen}
          >
            <Sparkles size={13} strokeWidth={1.5} /> {coachOpen ? 'Hide coach' : 'Show coach'}
          </button>
        </div>

        <label className="library-field">
          <span className="library-field__label">Title</span>
          <input
            className="library-field__input"
            data-testid="tile-title"
            value={draft.title}
            placeholder="Weekly mileage"
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
          />
        </label>

        <Chips label="Chart" options={CHART_TYPES} value={draft.chartType}
          onSelect={v => v && setDraft(d => ({ ...d, chartType: v }))} />

        <Chips label="Range" options={[
          { value: 'rolling' as const, label: 'Rolling' },
          { value: 'preset' as const, label: 'Preset' },
          { value: 'fixed' as const, label: 'Fixed dates' },
        ]} value={draft.rangeKind} onSelect={v => v && setDraft(d => ({ ...d, rangeKind: v }))} />

        {draft.rangeKind === 'rolling' && (
          <label className="library-field">
            <span className="library-field__label">Days back</span>
            <input
              className="library-field__input"
              inputMode="numeric"
              value={draft.rollingDays}
              onChange={e => setDraft(d => ({ ...d, rollingDays: e.target.value }))}
            />
          </label>
        )}
        {draft.rangeKind === 'preset' && (
          <Chips label="Preset" options={PRESETS} value={draft.preset}
            onSelect={v => v && setDraft(d => ({ ...d, preset: v }))} />
        )}
        {draft.rangeKind === 'fixed' && (
          <div className="library-field-row">
            <label className="library-field">
              <span className="library-field__label">From</span>
              <input type="date" className="library-field__input" value={draft.startDate}
                onChange={e => setDraft(d => ({ ...d, startDate: e.target.value }))} />
            </label>
            <label className="library-field">
              <span className="library-field__label">To (inclusive)</span>
              <input type="date" className="library-field__input" value={draft.endDate}
                onChange={e => setDraft(d => ({ ...d, endDate: e.target.value }))} />
            </label>
          </div>
        )}

        {draft.chartType !== 'kpi' && (
          <Chips label="Bucket" options={BUCKETS} value={draft.bucket}
            onSelect={v => v && setDraft(d => ({ ...d, bucket: v }))} />
        )}

        {draft.series.some(s => s.measure && MEASURES[s.measure].unitKind === 'length') && (
          <Chips label="Display unit" clearable="As logged"
            options={DISPLAY_UNITS.map(u => ({ value: u, label: u }))}
            value={draft.displayUnit}
            onSelect={v => setDraft(d => ({ ...d, displayUnit: v }))} />
        )}

        {draft.series.map((s, index) => (
          <SeriesEditor
            key={s.id}
            series={s}
            index={index}
            removable={draft.series.length > 1}
            otherWorkoutOptions={otherWorkoutOptions}
            categoryOptions={categoryOptions}
            onPatch={patch => patchSeries(s.id, patch)}
            onRemove={() => removeSeries(s.id)}
          />
        ))}

        <button className="an-add-series" data-testid="tile-add-series" onClick={addSeries}>
          <Plus size={14} strokeWidth={1.5} /> Add series
        </button>

        {saveProblem && (
          <div className="tile-problem" data-testid="tile-save-problem">{saveProblem}</div>
        )}

        <div className="exercise-editor__bar composer-actions">
          <button className="exercise-editor__cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="exercise-editor__save" data-testid="tile-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : tile ? 'Save changes' : 'Save tile'}
          </button>
        </div>
      </div>

      <div className="tile-builder__preview">
        <div className="an-field__label">Preview</div>
        {problem ? (
          <div className="tile-problem" data-testid="tile-builder-problem">{problem}</div>
        ) : preview ? (
          <div className="tile-builder__preview-chart" data-testid="tile-preview">
            <TileRenderer spec={'spec' in built ? built.spec : null} result={preview} />
          </div>
        ) : null}
        {!preview && <div className="an-loading">Loading data…</div>}
        {coachOpen && (
          <AnalyticsCoachPanel
            draft={draft}
            setDraft={setDraft}
            onClose={() => setCoachOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function SeriesEditor({ series: s, index, removable, otherWorkoutOptions, categoryOptions, onPatch, onRemove }: {
  series: SeriesDraft;
  index: number;
  removable: boolean;
  otherWorkoutOptions: Array<{ value: string; label: string }>;
  categoryOptions: Array<{ value: string; label: string }>;
  onPatch: (patch: Partial<SeriesDraft>) => void;
  onRemove: () => void;
}) {
  const def = s.measure ? MEASURES[s.measure] : null;
  const source = def?.source;
  // Every workout-joined source has the sport dimension; meals don't.
  const showSports = source !== undefined && source !== 'meals';
  const showLogFilters = source === 'set-logs' || source === 'pitch-logs' || source === 'cardio-logs';
  const showEventTypes = source !== undefined && source !== 'meals';
  const [filtersOpen, setFiltersOpen] = useState(
    () => s.eventTypes.length > 0 || s.sports.length > 0 || s.exerciseNames.length > 0 ||
      s.categories.length > 0 || s.mealTypes.length > 0 || s.dayFilterTypes.length > 0,
  );

  return (
    <section className="an-series" data-testid={`tile-series-${s.id}`}>
      <header className="an-series__head">
        <span className="an-series__name">Series {index + 1}</span>
        {removable && (
          <button className="an-series__remove" aria-label={`Remove series ${index + 1}`} onClick={onRemove}>
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </header>

      <div className="an-field">
        <span className="an-field__label">Measure</span>
        {MEASURE_GROUPS.map(group => (
          <div key={group.label} className="an-measure-group">
            <span className="an-measure-group__label">{group.label}</span>
            <div className="an-chips" role="radiogroup" aria-label={`${group.label} measures`}>
              {group.ids.map(id => {
                // The mirror of the sport-chip dimming: a sports filter
                // already chosen constrains which measures still make sense.
                const blockedBy = s.sports.filter(sport => !sportCompatible(id, sport));
                const off = s.measure !== id && blockedBy.length > 0;
                return (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={s.measure === id}
                    aria-disabled={off}
                    title={off ? `Incompatible with ${blockedBy.join(', ')}` : undefined}
                    className={`an-chip${s.measure === id ? ' an-chip--active' : ''}${off ? ' an-chip--dimmed' : ''}`}
                    onClick={() => { if (!off) onPatch({ measure: id, agg: '', groupBy: '' }); }}
                  >
                    {MEASURES[id].label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {def && (
        <>
          {def.allowedAggs.length > 1 && (
            <Chips label="Aggregation" clearable={`Auto (${def.defaultAgg})`}
              options={def.allowedAggs.map(a => ({ value: a as Aggregation, label: a }))}
              value={s.agg}
              onSelect={v => onPatch({ agg: v })} />
          )}

          {def.allowedGroupBys.length > 0 && (
            <Chips label="Split by" clearable="None"
              options={def.allowedGroupBys.map(g => ({ value: g as GroupBy, label: GROUP_BY_LABELS[g] }))}
              value={s.groupBy}
              onSelect={v => onPatch({ groupBy: v })} />
          )}

          {s.groupBy && (
            <label className="library-field">
              <span className="library-field__label">Top groups <em>optional, default 6</em></span>
              <input className="library-field__input" inputMode="numeric" value={s.groupLimit}
                onChange={e => onPatch({ groupLimit: e.target.value })} />
            </label>
          )}

          {source === 'pitch-logs' && (
            <Chips label="Grade scale" clearable={s.measure === 'max-grade' ? undefined : 'Any'}
              options={GRADE_SCALES}
              value={s.gradeScale}
              onSelect={v => onPatch({ gradeScale: v })} />
          )}

          <button className="an-filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(v => !v)}>
            Filters {filtersOpen ? '▾' : '▸'}
          </button>

          {filtersOpen && (
            <div className="an-filters">
              {showEventTypes && (
                <MultiChips label="Workout types" options={TYPE_OPTIONS} values={s.eventTypes}
                  colorFor={t => WORKOUT_COLORS[t as WorkoutType]?.border}
                  onToggle={v => onPatch({ eventTypes: toggle(s.eventTypes, v) })} />
              )}
              {showSports && (
                <MultiChips label="Sports" options={SPORT_OPTIONS} values={s.sports}
                  dimmed={sport => s.measure !== '' && !sportCompatible(s.measure, sport)}
                  dimReason={def ? `Incompatible with ${def.label}` : undefined}
                  onToggle={v => onPatch({ sports: toggle(s.sports, v) })} />
              )}
              {showSports && s.sports.includes('other') && otherWorkoutOptions.length > 0 && (
                <MultiChips label="Which workouts" options={otherWorkoutOptions} values={s.workoutTitles}
                  onToggle={v => onPatch({ workoutTitles: toggle(s.workoutTitles, v) })} />
              )}
              {showSports && s.sports.includes('other') && otherWorkoutOptions.length === 0 && (
                <p className="an-hint">{OTHER_SPORT_HINT}</p>
              )}
              {showLogFilters && (
                <label className="library-field">
                  <span className="library-field__label">Exercises <em>comma-separated, optional</em></span>
                  <input
                    className="library-field__input"
                    value={s.exerciseNames.join(', ')}
                    placeholder="Bench Press, Squat"
                    onChange={e => onPatch({
                      exerciseNames: e.target.value.split(',').map(x => x.trim()).filter(Boolean),
                    })}
                  />
                </label>
              )}
              {showLogFilters && categoryOptions.length > 0 && (
                <MultiChips label="Categories" options={categoryOptions} values={s.categories}
                  onToggle={v => onPatch({ categories: toggle(s.categories, v) })} />
              )}
              {source === 'meals' && (
                <MultiChips label="Meal types"
                  options={MEAL_TYPES.map(m => ({ value: m, label: m }))}
                  values={s.mealTypes}
                  onToggle={v => onPatch({ mealTypes: toggle(s.mealTypes, v) })} />
              )}

              <MultiChips label="Only days near a workout of…" options={TYPE_OPTIONS} values={s.dayFilterTypes}
                colorFor={t => WORKOUT_COLORS[t as WorkoutType]?.border}
                onToggle={v => onPatch({ dayFilterTypes: toggle(s.dayFilterTypes, v) })} />
              {s.dayFilterTypes.length > 0 && (
                <div className="library-field-row">
                  <label className="library-field">
                    <span className="library-field__label">Offset days <em>-7…7; 1 = day after</em></span>
                    <input className="library-field__input" inputMode="numeric" value={s.dayFilterOffset}
                      onChange={e => onPatch({ dayFilterOffset: e.target.value })} />
                  </label>
                  <Chips label="Mode" options={[
                    { value: 'include' as const, label: 'Only those days' },
                    { value: 'exclude' as const, label: 'Everything else' },
                  ]} value={s.dayFilterMode} onSelect={v => v && onPatch({ dayFilterMode: v })} />
                </div>
              )}
            </div>
          )}

          <label className="library-field">
            <span className="library-field__label">Series label <em>optional</em></span>
            <input className="library-field__input" value={s.label}
              onChange={e => onPatch({ label: e.target.value })} />
          </label>
        </>
      )}
    </section>
  );
}
