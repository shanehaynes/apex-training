import { useState } from 'react';
import { createPortal } from 'react-dom';
import { format, parseISO } from 'date-fns';
import { ArrowLeft, Sparkles, X } from 'lucide-react';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useCalendar } from '../../context/calendar';
import { useSchedule, type WorkoutDraftRequest } from '../../context/schedule';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { draftFromEvent, draftFromTemplate, emptyDraft, type WorkoutDraft } from '../../lib/builder/draft';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import TemplateSearch from './TemplateSearch';
import BuilderForm from './BuilderForm';
import BuilderCoachPanel from './BuilderCoachPanel';
import type { WorkoutTemplate } from '../../types/workout';

/**
 * The workout builder, a full-screen overlay (library/tracker pattern).
 * Create mode opens search-first over the workout library — picking a
 * template fills the form and pins its id, which is what keeps PR history
 * continuous across every instance of a named workout. Apply upserts the
 * template and schedules the event in one step (there is deliberately no
 * save-without-scheduling). Edit mode (state.editingWorkout) skips straight
 * to the form and saves back to the event without touching the library.
 *
 * Both paths are one POST /api/workout-draft (#136): the draft goes to the
 * server, which validates it and does the writing. This view holds no
 * validation of its own — the refusal comes back as `ok: false` and lands on
 * the cards (violations) or in a toast (a whole-draft problem).
 */
export default function WorkoutBuilderView() {
  const { state, dispatch } = useCalendar();
  const { definitions, templates, applyWorkoutDraft, archiveTemplate } = useSchedule();
  const editing = state.editingWorkout;
  const close = () => dispatch({ type: 'CLOSE_COMPOSER' });

  const [draft, setDraft] = useState<WorkoutDraft>(() => editing
    ? draftFromEvent(editing)
    : emptyDraft(state.composerDate ?? format(now(), 'yyyy-MM-dd')));
  const [step, setStep] = useState<'search' | 'form'>(editing ? 'form' : 'search');
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);

  useModalChrome(close);

  const pickTemplate = (t: WorkoutTemplate) => {
    setDraft(draftFromTemplate(t, draft.date));
    setStep('form');
  };

  const startBlank = (title: string) => {
    setDraft(emptyDraft(draft.date, title));
    setStep('form');
  };

  /**
   * Apply (create) and Save changes (update / detach), which are the same
   * request with a different action:
   *   create  — no event is being edited.
   *   detach  — a recurring occurrence saved with "This event only": the
   *             edits become a standalone event and the day leaves the
   *             series. The repeat picker doesn't apply; the server forces it
   *             off (a detached day cannot itself repeat).
   *   update  — everything else, including a series-wide save, where the
   *             anchor must not follow whichever occurrence was opened.
   */
  const submit = async (scope?: 'occurrence' | 'series') => {
    const request: WorkoutDraftRequest = !editing
      ? { kind: 'create' }
      : editing.isRecurring && scope === 'occurrence'
        ? { kind: 'detach', eventId: editing.id }
        : { kind: 'update', eventId: editing.id };

    setSaving(true);
    const result = await applyWorkoutDraft(draft, request);
    setSaving(false);

    // null = the request itself failed; the transport has already toasted the
    // detail, so this is the one line the user needs.
    if (!result) { notify('Failed to save — try again'); return; }
    if (!result.ok) {
      // Per-entry violations land on the cards that caused them, silently —
      // a toast would say less than the errors already on screen. A
      // whole-draft problem has no card to land on, so it toasts.
      if (result.violations && Object.keys(result.violations).length) {
        setErrors(new Map(Object.entries(result.violations)));
      } else {
        notify(result.problem);
      }
      return;
    }

    notify(
      request.kind === 'create' ? 'Workout added'
      : request.kind === 'detach' ? 'Saved — this day now stands alone'
      : 'Workout updated',
    );
    close();
  };

  const color = WORKOUT_COLORS[draft.type];
  const title = editing
    ? 'Edit Workout'
    : step === 'search' ? 'Add Workout' : (draft.templateId ? draft.title : 'New Workout');

  return createPortal(
    <div className={`composer-view builder-view${coachOpen && step === 'form' ? ' builder-view--coach' : ''}`}>
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
          {step === 'form' && (
            <button
              className={`library-close builder-coach-toggle${coachOpen ? ' builder-coach-toggle--on' : ''}`}
              onClick={() => setCoachOpen(v => !v)}
              aria-pressed={coachOpen}
              aria-label={coachOpen ? 'Hide coach' : 'Show coach'}
              title={coachOpen ? 'Hide coach' : 'Ask your coach to fill the form'}
            >
              <Sparkles size={16} strokeWidth={1.5} />
            </button>
          )}
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="builder-columns">
        <div className="builder-main">
          {step === 'search' ? (
            <TemplateSearch
              templates={templates}
              date={draft.date}
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
              onSubmit={submit}
              onCancel={close}
            />
          )}
        </div>
        {coachOpen && step === 'form' && (
          <BuilderCoachPanel
            draft={draft}
            setDraft={setDraft}
            definitions={definitions}
            templates={templates}
            onClose={() => setCoachOpen(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
