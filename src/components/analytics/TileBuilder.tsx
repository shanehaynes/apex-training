import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { notify } from '../../lib/notify';
import { useAnalytics } from '../../context/analytics';
import { useAnalyticsData } from '../../hooks/useAnalyticsData';
import { computeTile } from '../../lib/analytics/engine';
import {
  MEASURES,
  WORKOUT_TYPES,
  sportCompatible,
  type Aggregation,
  type ChartType,
  type DisplayUnit,
  type GroupBy,
  type MeasureId,
  type RangePreset,
  type TimeBucket,
} from '../../lib/analytics/spec';
import {
  draftFromSpec,
  emptyChartDraft,
  emptySeriesDraft,
  nextSeriesId,
  specFromDraft,
  type ChartDraft,
  type SeriesDraft,
} from '../../lib/analytics/draft';
import { mintTileId, type AnalyticsTile, type TileLayout } from '../../lib/analytics/tiles';
import TileRenderer from './TileRenderer';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import type { Sport, WorkoutType } from '../../types/workout';
import type { MealType } from '../../types/nutrition';
import type { GradeScale } from '../../lib/climbing';

// The tile editor: config column on the left, live preview on the right —
// the builder-view two-column pattern. All state is ONE ChartDraft (the
// src/lib/builder/draft.ts doctrine: plain object, numeric fields as
// strings, pure converters); every input writes here and the preview reads
// specFromDraft on each render, so what you see is exactly what Save
// persists. The analytics coach (follow-up PR) reduces onto this same
// object via applyChartDraftUpdate.

interface Props {
  tile: AnalyticsTile | null;
  onClose: () => void;
}

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'stacked-bar', label: 'Stacked' },
  { value: 'area', label: 'Area' },
  { value: 'kpi', label: 'Stat' },
  { value: 'table', label: 'Table' },
];

const BUCKETS: Array<{ value: TimeBucket; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'iso-month', label: 'Training month' },
  { value: 'total', label: 'Total' },
];

const PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'this-iso-month', label: 'This month' },
  { value: 'last-iso-month', label: 'Last month' },
  { value: 'this-iso-year', label: 'This year' },
  { value: 'last-iso-year', label: 'Last year' },
  { value: 'current-block', label: 'Current block' },
];

const DISPLAY_UNITS: DisplayUnit[] = ['mi', 'km', 'm', 'ft'];
const GRADE_SCALES: Array<{ value: GradeScale; label: string }> = [
  { value: 'yds', label: 'YDS' },
  { value: 'boulder', label: 'V-grade' },
  { value: 'ice', label: 'WI/AI' },
  { value: 'mixed', label: 'M' },
];
const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const MEASURE_GROUPS: Array<{ label: string; ids: MeasureId[] }> = [
  { label: 'Training', ids: ['session-count', 'training-time'] },
  { label: 'Strength', ids: ['set-count', 'rep-count', 'tonnage', 'est-1rm'] },
  { label: 'Climbing', ids: ['pitches', 'max-grade'] },
  { label: 'Cardio', ids: ['distance', 'elevation-gain', 'cardio-time', 'avg-hr', 'hr-zone-time'] },
  { label: 'Nutrition', ids: ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'alcohol', 'meal-count'] },
];

const SPORT_OPTIONS: Array<{ value: Sport; label: string }> = [
  { value: 'running', label: 'Running' },
  { value: 'biking', label: 'Biking' },
  { value: 'swimming', label: 'Swimming' },
  { value: 'climbing', label: 'Climbing' },
  { value: 'other', label: 'Other' },
];

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  'event-type': 'Workout type',
  sport: 'Sport',
  exercise: 'Exercise',
  category: 'Category',
  'meal-type': 'Meal type',
  'hr-zone': 'HR zone',
  unit: 'Unit',
};

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
  const { tiles, saveTile } = useAnalytics();
  const [draft, setDraft] = useState<ChartDraft>(() =>
    tile?.spec ? draftFromSpec(tile.spec) : emptyChartDraft(),
  );
  const [saving, setSaving] = useState(false);

  const built = useMemo(() => specFromDraft(draft), [draft]);
  const problem = 'error' in built ? built.error : null;
  const previewSpecs = useMemo(() => ('spec' in built ? [built.spec] : []), [built]);
  const data = useAnalyticsData(previewSpecs);
  const previewResult = useMemo(
    () => ('spec' in built ? computeTile(built.spec, data.inputs, data.ctx) : null),
    [built, data.inputs, data.ctx],
  );

  const patchSeries = (id: string, patch: Partial<SeriesDraft>) =>
    setDraft(d => ({ ...d, series: d.series.map(s => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSeries = () =>
    setDraft(d => ({ ...d, series: [...d.series, emptySeriesDraft(nextSeriesId(d))] }));

  const removeSeries = (id: string) =>
    setDraft(d => ({ ...d, series: d.series.filter(s => s.id !== id) }));

  // 'Other' narrows to the specific workouts the user made — the options
  // are their own sport='other' workout titles.
  const otherWorkoutOptions = useMemo(() => {
    const titles = [...new Set(
      [...data.inputs.events.values()].filter(e => e.sport === 'other').map(e => e.title.trim()).filter(Boolean),
    )].sort();
    return titles.map(t => ({ value: t, label: t }));
  }, [data.inputs.events]);
  const categoryOptions = useMemo(() => {
    const values = [...new Set(data.inputs.categories.values())].sort();
    return values.map(v => ({ value: v, label: v }));
  }, [data.inputs.categories]);

  const save = async () => {
    if (!('spec' in built)) {
      notify(built.error);
      return;
    }
    if (!draft.title.trim()) {
      notify('Give the tile a title');
      return;
    }
    const layout: TileLayout = tile
      ? tile.layout
      : { x: 0, y: tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0), w: 6, h: 4 };
    setSaving(true);
    const ok = await saveTile(tile?.id ?? mintTileId(), built.spec, layout);
    setSaving(false);
    if (ok) {
      notify(tile ? 'Tile updated' : 'Tile added');
      onClose();
    }
  };

  return (
    <div className="tile-builder">
      <div className="tile-builder__config">
        <div className="tile-builder__head">
          <button className="library-back" onClick={onClose} aria-label="Back to dashboard">
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <h2 className="tile-builder__heading">{tile ? 'Edit tile' : 'New tile'}</h2>
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
        ) : (
          <div className="tile-builder__preview-chart" data-testid="tile-preview">
            <TileRenderer spec={'spec' in built ? built.spec : null} result={previewResult} />
          </div>
        )}
        {data.loading && <div className="an-loading">Loading data…</div>}
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
                <p className="an-hint">No workouts marked “Other sport” yet — set a sport on a workout in the builder.</p>
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
