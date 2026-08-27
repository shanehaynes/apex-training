import { useState } from 'react';
import { createPortal } from 'react-dom';
import { format, parseISO } from 'date-fns';
import { ArrowLeft, X } from 'lucide-react';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { matchTemplateByTitle } from '../../lib/schedule/templates';
import {
  createInputFromDraft, draftFromEvent, draftFromTemplate, draftProblem,
  emptyDraft, eventFieldsFromDraft, templateInputFromDraft, type WorkoutDraft,
} from '../../lib/builder/draft';
import { REPEAT_OFF } from '../../lib/builder/repeat';
import { validateUnilateral } from '../modal/EventExerciseEditor';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import TemplateSearch from './TemplateSearch';
import BuilderForm from './BuilderForm';
import type { WorkoutTemplate } from '../../types/workout';

/**
 * The workout builder, a full-screen overlay (library/tracker pattern).
 * Create mode opens search-first over the workout library — picking a
 * template fills the form and pins its id, which is what keeps PR history
 * continuous across every instance of a named workout. Apply upserts the
 * template and schedules the event in one step (there is deliberately no
 * save-without-scheduling). Edit mode (state.editingWorkout) skips straight
 * to the form and saves back to the event without touching the library.
 */
export default function WorkoutBuilderView() {
  const { state, dispatch } = useCalendar();
  const { definitions, templates, createEvent, updateEvent, detachOccurrence, saveTemplate, archiveTemplate } = useSchedule();
  const editing = state.editingWorkout;
  const close = () => dispatch({ type: 'CLOSE_COMPOSER' });

  const [draft, setDraft] = useState<WorkoutDraft>(() => editing
    ? draftFromEvent(editing)
    : emptyDraft(state.composerDate ?? format(now(), 'yyyy-MM-dd')));
  const [step, setStep] = useState<'search' | 'form'>(editing ? 'form' : 'search');
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  useModalChrome(close);

  const pickTemplate = (t: WorkoutTemplate) => {
    setDraft(draftFromTemplate(t, draft.date));
    setStep('form');
  };

  const startBlank = (title: string) => {
    setDraft(emptyDraft(draft.date, title));
    setStep('form');
  };

  const validate = (): boolean => {
    const problem = draftProblem(draft);
    if (problem) { notify(problem); return false; }
    const violations = validateUnilateral(draft.lists, definitions);
    setErrors(violations);
    return violations.size === 0;
  };

  const apply = async () => {
    if (!validate()) return;
    setSaving(true);
    // Identity resolution before the upsert: the picked template's id, else a
    // case-insensitive title match (reapplying an archived title revives it,
    // reconnecting its score history), else saveTemplate mints a fresh id.
    const existingId = draft.templateId ?? matchTemplateByTitle(templates.values(), draft.title)?.id;
    const saved = await saveTemplate({ id: existingId, ...templateInputFromDraft(draft) });
    const created = saved ? await createEvent(createInputFromDraft(draft, saved.id)) : null;
    setSaving(false);
    if (created) {
      notify('Workout added');
      close();
    } else {
      notify('Failed to save — try again');
    }
  };

  const saveChanges = async (scope?: 'occurrence' | 'series') => {
    if (!editing) return;
    if (!validate()) return;
    setSaving(true);
    let ok: boolean;
    if (editing.isRecurring && scope === 'occurrence') {
      // Detach: the edits (schedule included) become a standalone event and
      // this day leaves the series. The repeat picker doesn't apply — a
      // detached day cannot itself repeat.
      const fields = eventFieldsFromDraft({ ...draft, repeat: REPEAT_OFF }, { includeSchedule: true });
      ok = !!(await detachOccurrence(editing.id, fields));
    } else {
      // Series-wide (or a plain one-off): the anchor date/times of a series
      // must not follow whichever occurrence happened to be opened.
      const fields = eventFieldsFromDraft(draft, { includeSchedule: !editing.isRecurring });
      ok = await updateEvent({ id: editing.id, fields });
    }
    setSaving(false);
    if (ok) {
      notify(scope === 'occurrence' ? 'Saved — this day now stands alone' : 'Workout updated');
      close();
    } else {
      notify('Failed to save — try again');
    }
  };

  const color = WORKOUT_COLORS[draft.type];
  const title = editing
    ? 'Edit Workout'
    : step === 'search' ? 'Add Workout' : (draft.templateId ? draft.title : 'New Workout');

  return createPortal(
    <div className="composer-view builder-view">
      <header className="library-header">
        <div className="library-header__titles">
          {!editing && step === 'form' && (
            <button className="library-back" onClick={() => setStep('search')} aria-label="Back to workout search">
              <ArrowLeft size={16} strokeWidth={1.5} />
            </button>
          )}
          <h1 className="library-header__title">{title}</h1>
          <span className="library-header__count">{format(parseISO(draft.date), 'EEEE, MMM d')}</span>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      {step === 'search' ? (
        <TemplateSearch
          templates={templates}
          onPick={pickTemplate}
          onCreateNew={startBlank}
          onArchive={archiveTemplate}
        />
      ) : (
        <BuilderForm
          draft={draft}
          setDraft={setDraft}
          errors={errors}
          saving={saving}
          mode={editing ? 'edit' : 'create'}
          isRecurringSeries={!!editing?.isRecurring}
          accentColor={color.solid}
          onSubmit={editing ? saveChanges : apply}
          onCancel={close}
        />
      )}
    </div>,
    document.body,
  );
}
