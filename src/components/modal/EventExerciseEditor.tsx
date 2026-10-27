import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import type { Announcements, DragEndEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Link2, Plus, X } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { baseIdOf } from '../../lib/schedule/occurrence';
import { draftFromEvent } from '../../lib/builder/draft';
import { withPrescriptionPatch } from '../../lib/builder/plannedSets';
import { asksScope, saveRequest } from './exerciseScope';
import type { SaveScope } from './exerciseScope';
import { entryFromDefinition, uniqueEntryId, validateUnilateral } from '../../lib/schedule/definitions';
import type { SectionKey, SectionLists } from '../../lib/schedule/definitions';
import { linkWithAbove, moveEntry as moveWithin, normalizeSupersets, unlink } from '../../lib/schedule/supersets';
import { notify } from '../../lib/notify';
import { CLIMB_STYLES, ascentStylesFor, climbStyleLabel, sectionLabels } from '../../lib/climbing';
import ExercisePicker from './ExercisePicker';
import PlannedSetsEditor from './PlannedSetsEditor';
import '../../styles/exercise-reorder.css';
import type { AscentStyle, ClimbStyle, Exercise, ExerciseCategory, ExerciseDefinition, WorkoutEvent, WorkoutType } from '../../types/workout';

export type { SectionKey, SectionLists };

const SECTION_KEYS: SectionKey[] = ['warmup', 'exercises', 'cooldown'];

interface Props {
  event: WorkoutEvent;
  accentColor: string;
  onDone: () => void;
}

// Cards only move within their own section's column.
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function EditorCard({
  entry, index, count, error, canLink, onChange, onRemove, onToggleLink, onMoveTo,
}: {
  entry: Exercise;
  /** This card's place in its section, from 0. */
  index: number;
  /** How many cards the section holds. */
  count: number;
  error?: string;
  /** False on a section's first entry — there is nothing above to pair with. */
  canLink: boolean;
  onChange: (patch: Partial<Exercise>) => void;
  onRemove: () => void;
  onToggleLink: () => void;
  onMoveTo: (index: number) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: entry.id });
  const style: CSSProperties = {
    // Translate, not Transform: cards differ in height, and a scale would
    // stretch the one being dragged to the height of the slot it is over.
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`editor-card${isDragging ? ' editor-card--dragging' : ''}`}
    >
      <div className="editor-card__header">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="editor-card__grip"
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${entry.name}`}
        >
          <GripVertical size={14} strokeWidth={1.5} />
        </button>
        <span className="editor-card__name">{entry.name}</span>
        {count > 1 && (
          // A far move in one step — dragging the tenth card to the top of a
          // long section means a long scroll, which this skips.
          <select
            className="editor-card__position"
            value={index}
            onChange={e => onMoveTo(Number(e.target.value))}
            aria-label={`Position of ${entry.name}`}
            title="Move to position"
          >
            {Array.from({ length: count }, (_, i) => (
              <option key={i} value={i}>{i + 1}</option>
            ))}
          </select>
        )}
        {entry.superset && <span className="superset-badge">{entry.superset}</span>}
        {(canLink || entry.superset) && (
          <button
            className={`editor-card__link${entry.superset ? ' editor-card__link--on' : ''}`}
            onClick={onToggleLink}
            aria-pressed={!!entry.superset}
            aria-label={entry.superset
              ? `Remove ${entry.name} from superset ${entry.superset}`
              : `Superset ${entry.name} with the exercise above`}
            title={entry.superset ? 'Leave superset' : 'Superset with above'}
          >
            <Link2 size={13} strokeWidth={1.5} />
          </button>
        )}
        <button className="editor-card__remove" onClick={onRemove} aria-label={`Remove ${entry.name}`}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      {entry.category === 'climbing' ? (
        <div className="editor-card__prescription">
          <label className="editor-field">
            <span>Style</span>
            <select
              value={entry.climbStyle ?? 'sport'}
              onChange={e => {
                const style = e.target.value as ClimbStyle;
                // Boulders can't be followed — a follow selection dies with the switch.
                const clearFollow = style === 'boulder' && entry.ascentStyle === 'follow';
                onChange({
                  climbStyle: style,
                  name: climbStyleLabel(style),
                  ...(clearFollow ? { ascentStyle: undefined } : {}),
                });
              }}
            >
              {CLIMB_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="editor-field">
            <span>Grade</span>
            <input
              value={entry.grade ?? ''}
              placeholder="5.11a / V5 / WI4"
              onChange={e => onChange({ grade: e.target.value || undefined })}
            />
          </label>
          <label className="editor-field">
            <span>Ascent</span>
            <select
              value={entry.ascentStyle ?? ''}
              onChange={e => onChange({ ascentStyle: (e.target.value || undefined) as AscentStyle | undefined })}
            >
              <option value="">—</option>
              {ascentStylesFor(entry.climbStyle).map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>
      ) : (
      <div className="editor-card__prescription">
        <label className="editor-field">
          <span>Sets</span>
          <input
            inputMode="numeric"
            value={entry.sets ?? ''}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              onChange({ sets: Number.isFinite(n) ? n : undefined });
            }}
          />
        </label>
        <label className="editor-field">
          <span>Reps</span>
          <input value={entry.reps ?? ''} onChange={e => onChange({ reps: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Duration</span>
          <input value={entry.duration ?? ''} onChange={e => onChange({ duration: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Weight</span>
          <input value={entry.weight ?? ''} onChange={e => onChange({ weight: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Rest</span>
          <input value={entry.restPeriod ?? ''} onChange={e => onChange({ restPeriod: e.target.value || undefined })} />
        </label>
      </div>
      )}
      {entry.category !== 'climbing' && (
        <PlannedSetsEditor entry={entry} onChange={plannedSets => onChange({ plannedSets })} />
      )}
      {error && <p className="editor-card__error">{error}</p>}
    </li>
  );
}

interface SectionsProps {
  lists: SectionLists;
  onChange: (lists: SectionLists) => void;
  errors: Map<string, string>;
  /** Pre-selects the library picker's category filter (clearable to all). */
  pickerCategory?: ExerciseCategory;
  /** Drives section labels and outdoor-climbing behavior (pitches, cardio approach/descent). */
  workoutType?: WorkoutType;
}

/**
 * Controlled three-section (warm-up / main / cool-down) exercise editor: add
 * via the library picker, remove, reorder (drag the grip, or pick a position),
 * edit prescriptions inline.
 * State lives in the caller — used against a saved event by the default
 * export below and against a draft by the add-event composer. Entry ids never
 * change — logged sets key on them (see uniqueEntryId).
 *
 * Outdoor climbing repurposes the sections: warm-up becomes the Approach and
 * cool-down the Descent (both picked from cardio), and main work is a pitch
 * list — one climbing entry per pitch, added directly instead of via the
 * library picker.
 */
export function ExerciseSectionsEditor({ lists, onChange, errors, pickerCategory, workoutType }: SectionsProps) {
  const [pickerSection, setPickerSection] = useState<SectionKey | null>(null);

  const outdoor = workoutType === 'outdoor-climbing';
  const labels = sectionLabels(workoutType);
  const sections = SECTION_KEYS.map(key => ({
    key,
    label: labels[key],
    pickerCategory: outdoor && key !== 'exercises' ? 'cardio' as const : pickerCategory,
    pitchMode: outdoor && key === 'exercises',
  }));

  const allIds = useMemo(
    () => Object.values(lists).flat().map(e => e.id),
    [lists],
  );

  const setSection = (key: SectionKey, entries: Exercise[]) =>
    onChange({ ...lists, [key]: entries });

  // Groups are adjacency: a move (or a removal below) re-letters and clears
  // any singleton the move left behind.
  const moveEntry = (key: SectionKey, from: number, to: number) => {
    const moved = moveWithin(lists[key], from, to);
    if (moved !== lists[key]) setSection(key, moved);
  };

  // While a card is held, Escape cancels the drag (dnd-kit listens for it on
  // the document) and must not also reach the modal, whose Escape closes the
  // editor and drops every unsaved edit. A capture listener claims the key
  // first; dnd-kit still sees it, and useModalChrome skips claimed keys.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const claim = (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault(); };
    document.addEventListener('keydown', claim, true);
    return () => document.removeEventListener('keydown', claim, true);
  }, [dragging]);

  // Screen readers hear the exercise and its place, not the entry id.
  const announcementsFor = (key: SectionKey): Announcements => {
    const entries = lists[key];
    const name = (id: UniqueIdentifier) => entries.find(e => e.id === id)?.name ?? 'Exercise';
    const place = (id: UniqueIdentifier) =>
      `position ${entries.findIndex(e => e.id === id) + 1} of ${entries.length}`;
    return {
      onDragStart: ({ active }) => `Picked up ${name(active.id)}, ${place(active.id)}.`,
      onDragOver: ({ active, over }) => over
        ? `${name(active.id)} is over ${place(over.id)}.`
        : `${name(active.id)} is outside the list.`,
      onDragEnd: ({ active, over }) => over
        ? `${name(active.id)} dropped at ${place(over.id)}.`
        : `${name(active.id)} dropped back in place.`,
      onDragCancel: ({ active }) => `Move cancelled. ${name(active.id)} is back in place.`,
    };
  };

  const onDragEnd = (key: SectionKey) => ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (!over) return;
    const ids = lists[key].map(e => e.id);
    moveEntry(key, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };

  // The pointer sensor serves mouse and touch alike: the grip sets
  // touch-action: none, so a finger on it drags instead of scrolling.
  // Dragging near the scroll container's edge auto-scrolls it (dnd-kit's
  // default), and the drop target accounts for that scroll — a card can
  // travel past everything that was on screen when it was picked up.
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const addPitch = (key: SectionKey) => {
    // New pitches inherit the previous pitch's style — multi-pitch days
    // rarely switch disciplines between pitches.
    const style: ClimbStyle = lists[key].filter(e => e.category === 'climbing').at(-1)?.climbStyle ?? 'sport';
    const entry: Exercise = {
      id: uniqueEntryId('pitch', allIds),
      name: climbStyleLabel(style),
      category: 'climbing',
      climbStyle: style,
    };
    setSection(key, [...lists[key], entry]);
  };

  // A prescription edit keeps any per-set targets (a new set count resizes
  // the table); the disclosure's own actions are the only writers of the
  // rows themselves.
  const updateEntry = (key: SectionKey, id: string, patch: Partial<Exercise>) =>
    setSection(key, lists[key].map(e => (e.id === id ? withPrescriptionPatch(e, patch) : e)));

  const addFromDefinition = (def: ExerciseDefinition) => {
    if (!pickerSection) return;
    const entry = entryFromDefinition(def, uniqueEntryId(def.id, allIds));
    setSection(pickerSection, [...lists[pickerSection], entry]);
    setPickerSection(null);
  };

  return (
    <>
      {sections.map(({ key, label, pitchMode }) => (
        <div key={key} className="modal-section">
          <div className="modal-section__header">
            <span className="modal-section__line" />
            <span className="modal-section__label">{label}</span>
            <span className="modal-section__line" />
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[verticalOnly]}
            accessibility={{ announcements: announcementsFor(key) }}
            onDragStart={() => setDragging(true)}
            onDragCancel={() => setDragging(false)}
            onDragEnd={onDragEnd(key)}
          >
            <SortableContext items={lists[key].map(e => e.id)} strategy={verticalListSortingStrategy}>
              <ul className="exercise-editor__list">
                {lists[key].map((entry, idx) => (
                  <EditorCard
                    key={entry.id}
                    entry={entry}
                    index={idx}
                    count={lists[key].length}
                    error={errors.get(entry.id)}
                    canLink={idx > 0}
                    onChange={patch => updateEntry(key, entry.id, patch)}
                    onRemove={() => setSection(key, normalizeSupersets(lists[key].filter(e => e.id !== entry.id)))}
                    onToggleLink={() => setSection(key, entry.superset
                      ? unlink(lists[key], entry.id)
                      : linkWithAbove(lists[key], entry.id))}
                    onMoveTo={to => moveEntry(key, idx, to)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {pitchMode ? (
            <button className="exercise-editor__add" onClick={() => addPitch(key)}>
              <Plus size={14} strokeWidth={1.5} /> Add pitch
            </button>
          ) : (
            <button className="exercise-editor__add" onClick={() => setPickerSection(key)}>
              <Plus size={14} strokeWidth={1.5} /> Add exercise
            </button>
          )}
        </div>
      ))}

      {pickerSection && (
        <ExercisePicker
          onSelect={addFromDefinition}
          onClose={() => setPickerSection(null)}
          initialCategory={sections.find(s => s.key === pickerSection)?.pickerCategory}
        />
      )}
    </>
  );
}

// The last scope chosen in this tab: the chooser opens with it focused, so a
// user who keeps tweaking single days is not re-deciding each time. The
// editor unmounts on every save, which is why this outlives the component.
let rememberedScope: SaveScope | null = null;

/**
 * Edit mode for the modal's exercise sections. Edits batch locally and
 * commit as one write on Save: a PATCH of the base event, or — "This day
 * only" on a series — the builder's detach, which the modal then follows to
 * the standalone event.
 */
export default function EventExerciseEditor({ event, accentColor, onDone }: Props) {
  const { definitions, updateEvent, applyWorkoutDraft } = useSchedule();
  const { dispatch } = useCalendar();
  const [lists, setLists] = useState<SectionLists>({
    warmup: event.warmup ?? [],
    exercises: event.exercises,
    cooldown: event.cooldown ?? [],
  });
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [choosingScope, setChoosingScope] = useState(false);
  const [lastScope, setLastScope] = useState<SaveScope | null>(rememberedScope);

  const seriesWide = asksScope(event);

  const changedFields = (): Partial<WorkoutEvent> => {
    const fields: Partial<WorkoutEvent> = {};
    if (JSON.stringify(lists.warmup) !== JSON.stringify(event.warmup ?? [])) fields.warmup = lists.warmup;
    if (JSON.stringify(lists.exercises) !== JSON.stringify(event.exercises)) fields.exercises = lists.exercises;
    if (JSON.stringify(lists.cooldown) !== JSON.stringify(event.cooldown ?? [])) fields.cooldown = lists.cooldown;
    return fields;
  };

  const saveSeries = async (fields: Partial<WorkoutEvent>) => {
    setSaving(true);
    const ok = await updateEvent({ id: baseIdOf(event.id), fields, triggeredBy: 'user' });
    setSaving(false);
    if (ok) {
      notify('Exercises updated');
      onDone();
    } else {
      notify('Failed to save — try again');
    }
  };

  // The builder's detach, as one POST: the occurrence becomes a standalone
  // event with these exercises, or nothing changes at all — never a detached
  // day still carrying the old plan.
  const saveThisDay = async () => {
    setSaving(true);
    const result = await applyWorkoutDraft(
      { ...draftFromEvent(event), lists },
      { kind: 'detach', eventId: event.id },
    );
    setSaving(false);
    // null = the request itself failed; the transport has already toasted
    // the detail (the builder's own wording for the same outcome).
    if (!result) { notify('Failed to save — try again'); return; }
    if (!result.ok) {
      if (result.violations && Object.keys(result.violations).length) {
        setErrors(new Map(Object.entries(result.violations)));
      } else {
        notify(result.problem);
      }
      return;
    }
    // The modal reads its event by id, and the occurrence id just stopped
    // expanding: point it at the standalone so the user keeps looking at the
    // day they edited.
    dispatch({ type: 'SELECT_EVENT', payload: result.event });
    notify('Saved — this day now stands alone');
    onDone();
  };

  const save = async () => {
    const violations = validateUnilateral(lists, definitions);
    setErrors(violations);
    if (violations.size > 0) return;
    const fields = changedFields();
    if (Object.keys(fields).length === 0) { onDone(); return; }
    if (seriesWide) setChoosingScope(true);
    else await saveSeries(fields);
  };

  const choose = async (scope: SaveScope) => {
    rememberedScope = scope;
    setLastScope(scope);
    if (saveRequest(event, scope).kind === 'detach') await saveThisDay();
    else await saveSeries(changedFields());
  };

  return (
    <div className="exercise-editor">
      {seriesWide && (
        <p className="exercise-editor__series-note">
          This workout repeats. Save asks whether the change is for this day only or the whole series.
        </p>
      )}

      <ExerciseSectionsEditor lists={lists} onChange={setLists} errors={errors} workoutType={event.type} />

      {choosingScope ? (
        <div className="exercise-editor__bar builder-scope">
          <span className="builder-scope__question">
            Save to this day only — it leaves the series for good, keeping anything logged — or to the whole series?
          </span>
          <button className="exercise-editor__cancel" onClick={() => setChoosingScope(false)} disabled={saving}>
            Back
          </button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={() => choose('occurrence')}
            disabled={saving}
            autoFocus={lastScope === 'occurrence'}
            data-default={lastScope === 'occurrence' || undefined}
          >
            {saving ? 'Saving…' : 'This day only'}
          </button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={() => choose('series')}
            disabled={saving}
            autoFocus={lastScope === 'series'}
            data-default={lastScope === 'series' || undefined}
          >
            {saving ? 'Saving…' : 'Whole series'}
          </button>
        </div>
      ) : (
        <div className="exercise-editor__bar">
          <button className="exercise-editor__cancel" onClick={onDone} disabled={saving}>Cancel</button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save exercises'}
          </button>
        </div>
      )}
    </div>
  );
}
