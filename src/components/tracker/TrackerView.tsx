import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, CheckCircle2, Flag, Plus, Trash2 } from 'lucide-react';
import { format, parseISO, subDays } from 'date-fns';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { formatElapsed } from '../../lib/time';
import { notify } from '../../lib/notify';
import { getWorkoutColor } from '../../utils/workoutColors';
import { pauseCause, useWorkoutSession } from '../../hooks/useWorkoutSession';
import type { TrackedSection } from '../../lib/db/types';
import type { ExerciseCategory, ExerciseDefinition, WorkoutEvent } from '../../types/workout';
import { eventPitches, isOutdoorClimbing } from '../../lib/climbing';
import TrackerExercise from './TrackerExercise';
import ExercisePicker from '../modal/ExercisePicker';
import WorkoutSummary from './WorkoutSummary';
import ConfirmBar from './ConfirmBar';
import UnsavedBar from './UnsavedBar';
import ScorePrompt from './ScorePrompt';
import type { SessionScore } from '../../lib/tracking/records';
import type { TrackedSectionGroup } from '../../lib/tracking/plan';
import { useTip } from '../../hooks/useTip';
import { useTrackerRestTimer } from '../../hooks/useRestTimer';
import RestTimerBar from './RestTimerBar';
import { isRpeTrackingEnabled } from '../../lib/tracking/fields';
import '../../styles/set-metadata.css';

// <input type="datetime-local"> speaks local wall-clock time without a zone.
const INPUT_DATETIME = "yyyy-MM-dd'T'HH:mm";
const toInputDateTime = (iso: string | null | undefined, fallback: string): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? fallback : format(new Date(t), INPUT_DATETIME);
};

/**
 * The tracker's two first-open tips. A child rendered only while a session is
 * loaded, unfinished and uncovered (no confirm bar, score step or summary), so
 * both register in the same commit — the shadow tip, conditioned, beats the
 * plain first-open one when last time's numbers are on screen — and neither
 * rides along behind the calendar, where TrackerView stays mounted.
 *
 * Nothing in the tracker takes focus on open, so TipHost's 600 ms settle
 * lands before the user can be mid-typing; a user who taps a box inside that
 * window gets the card after the box loses focus.
 */
function TrackerTips({ groups }: { groups: TrackedSectionGroup[] }) {
  const hasShadow = groups.some(g => g.exercises.some(t => !!t.cardio?.shadow || t.sets.some(s => !!s.shadow)));
  useTip('tracker-first');
  useTip('tracker-shadow', hasShadow);
  return null;
}

// Anything that logs as sets or as one cardio row — and, in a climbing
// session, another pitch: an added pitch is one row asking for its grade,
// style and attempts. Elsewhere a pitch has no place to go.
const ADDABLE_CATEGORIES: ExerciseCategory[] = ['strength', 'stretch', 'mobility', 'skill', 'cardio'];
const ADDABLE_IN_A_CLIMB: ExerciseCategory[] = [...ADDABLE_CATEGORIES, 'climbing'];

/** An outdoor climb, or any session whose plan already holds a pitch. */
function isClimbingSession(event: WorkoutEvent): boolean {
  return isOutdoorClimbing(event.type) || eventPitches(event.exercises).length > 0;
}

export default function TrackerView() {
  const { state, dispatch } = useCalendar();
  const { setCompletion } = useSchedule();
  const event = state.trackingSession;

  const {
    groups, session, elapsed, isFinished, isFinishing, isCancelling, summary, saveState, sessionNote,
    onSetChange, onSetMetaChange, onSessionNoteChange, editTimes, onCardioChange, onCommitSetShadow, onCommitCardioShadow, onAddSet, onRemoveSet,
    onAddExercise, onRemoveAddedExercise, onSwapExercise, onNoteChange, flushSave, retrySave, getSaveState, requestFinish, cancelWorkout, openSavedSummary, dismissSummary,
  } = useWorkoutSession(event, setCompletion);

  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [addingExercise, setAddingExercise] = useState(false);
  // Editing a finished session's start and finish (R4.2: finished only).
  // Drafts are datetime-local strings; the server holds the bounds and says
  // why an edit is refused (a quick-complete, a synced activity).
  const [timesOpen, setTimesOpen] = useState(false);
  const [startDraft, setStartDraft] = useState('');
  const [finishDraft, setFinishDraft] = useState('');
  const [savingTimes, setSavingTimes] = useState(false);
  // A device preference (Profile → Training), read on every paint so a
  // change made with the tracker mounted behind the calendar shows on return.
  const showRpe = isRpeTrackingEnabled();
  // Rest countdown between sets: a row's first non-empty reps/duration (or
  // its ghost tapped) starts it from the exercise's rest text (lib/tracking/rest.ts).
  const rest = useTrackerRestTimer({ groups, sessionKey: event?.id ?? null, finished: isFinished });

  const color = event ? getWorkoutColor(event.type) : null;
  if (!event || !color) return null;
  const climbing = isClimbingSession(event);

  // Leaving the tracker drops its save queue, so Back waits for the save:
  // a failed flush keeps the session open with its edits still dirty (the
  // queue keeps retrying; the bar's Retry sends now) rather than losing them.
  // A paused queue is the exception: nothing will land until the user signs
  // in or accepts the terms, and holding them in the tracker until then is
  // not a save, so Back leaves and says what is lost and why. Refused edits
  // are the user's call to abandon — said out loud, never silently.
  const close = async () => {
    if (isCancelling) return;
    const saved = await flushSave();
    const { paused, pausedStatus, pending, rejected } = getSaveState();
    if (!saved && !paused) {
      notify('Unsaved changes — retry before leaving');
      return;
    }
    const lost = paused ? pending + rejected : rejected;
    if (lost > 0) {
      const edits = lost === 1 ? 'edit' : 'edits';
      notify(paused
        ? `${lost} unsaved ${edits} will be lost — ${pauseCause(pausedStatus)}`
        : `${lost} refused ${edits} will be lost`);
    }
    dispatch({ type: 'STOP_TRACKING' });
  };

  const handleFinish = async (score?: SessionScore | null) => {
    // A visible confirm bar means the user already saw the unlogged count —
    // the next press (header button or "Finish anyway") finishes for real.
    // Scored workouts then get the score step before anything is stamped.
    const result = await requestFinish(confirmCount !== null || scoreOpen, score);
    if (result.status === 'needs-confirm') {
      setConfirmCancel(false);
      setScoreOpen(false);
      setConfirmCount(result.count);
    } else if (result.status === 'needs-score') {
      setConfirmCount(null);
      setConfirmCancel(false);
      setScoreOpen(true);
    } else {
      setConfirmCount(null);
      setScoreOpen(false);
    }
  };

  const handleSwap = async (section: TrackedSection, exerciseId: string, def: ExerciseDefinition) => {
    const ok = await onSwapExercise(section, exerciseId, def);
    notify(ok ? `Logged as ${def.canonicalName}` : 'Failed to swap — try again');
  };

  const handleCancelWorkout = async () => {
    if (await cancelWorkout()) dispatch({ type: 'STOP_TRACKING' });
    else setConfirmCancel(false);
  };

  const openTimes = () => {
    setStartDraft(toInputDateTime(session?.started_at, `${event.date}T09:00`));
    setFinishDraft(toInputDateTime(session?.finished_at, `${event.date}T10:00`));
    setTimesOpen(true);
  };
  const draftStart = Date.parse(startDraft);
  const draftFinish = Date.parse(finishDraft);
  const draftSeconds = Number.isNaN(draftStart) || Number.isNaN(draftFinish)
    ? null
    : Math.round((draftFinish - draftStart) / 1000);
  const submitTimes = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draftSeconds === null) { notify('Both times are needed'); return; }
    if (draftSeconds < 0) { notify('The finish must come after the start'); return; }
    setSavingTimes(true);
    const ok = await editTimes(new Date(draftStart).toISOString(), new Date(draftFinish).toISOString());
    setSavingTimes(false);
    if (ok) setTimesOpen(false);
  };

  return createPortal(
    <div className="tracker">
      {groups && !isFinished && !summary && confirmCount === null && !scoreOpen && !confirmCancel && (
        <TrackerTips groups={groups} />
      )}
      <header className="tracker-header" style={{ borderBottom: `2px solid ${color.solid}` }}>
        <button className="tracker-header__back" onClick={close} aria-label="Back to calendar">
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>
        <div className="tracker-header__titles">
          <span className="tracker-header__title">{event.title}</span>
          <span className="tracker-header__date">{format(parseISO(event.date), 'EEEE, MMM d')}</span>
        </div>
        {isFinished ? (
          <button
            type="button"
            className="tracker-header__timer tracker-header__timer--done tracker-header__timer--button"
            onClick={openTimes}
            disabled={!groups}
            title="Edit when this workout started and finished"
            aria-label={`Duration ${formatElapsed(elapsed)} — edit start and finish times`}
          >
            {formatElapsed(elapsed)}
          </button>
        ) : (
          <span className="tracker-header__timer">
            {formatElapsed(elapsed)}
          </span>
        )}
        {isFinished ? (
          <button
            className="tracker-header__done-badge tracker-header__done-badge--button"
            style={{ color: color.solid }}
            onClick={openSavedSummary}
            disabled={!groups}
            title="View workout summary"
          >
            <CheckCircle2 size={15} strokeWidth={2} /> Done
          </button>
        ) : (
          <button
            className="tracker-header__finish"
            style={{ background: color.solid }}
            onClick={() => handleFinish()}
            disabled={!groups || isFinishing}
          >
            <Flag size={14} strokeWidth={2} /> Finish
          </button>
        )}
      </header>

      {saveState.showBar && <UnsavedBar state={saveState} onRetry={() => { retrySave(); }} />}
      {rest.running && (
        <RestTimerBar remaining={rest.remaining} progress={rest.progress} label={rest.exerciseLabel} onExtend={rest.extend} onSkip={rest.skip} />
      )}
      {timesOpen && isFinished && (
        <form className="tracker-times" data-testid="edit-times" onSubmit={submitTimes}>
          <label className="tracker-times__field">
            <span>Started</span>
            <input
              type="datetime-local"
              className="tracker-input"
              aria-label="Started at"
              value={startDraft}
              min={format(subDays(parseISO(event.date), 1), INPUT_DATETIME)}
              onChange={e => setStartDraft(e.target.value)}
              required
            />
          </label>
          <label className="tracker-times__field">
            <span>Finished</span>
            <input
              type="datetime-local"
              className="tracker-input"
              aria-label="Finished at"
              value={finishDraft}
              min={startDraft || undefined}
              onChange={e => setFinishDraft(e.target.value)}
              required
            />
          </label>
          <span className="tracker-times__preview" aria-live="polite">
            {draftSeconds !== null && draftSeconds >= 0 ? formatElapsed(draftSeconds) : '—'}
          </span>
          <div className="tracker-times__actions">
            <button type="button" className="tracker-times__btn" onClick={() => setTimesOpen(false)} disabled={savingTimes}>
              Cancel
            </button>
            <button
              type="submit"
              className="tracker-times__btn tracker-times__btn--primary"
              style={{ background: color.solid }}
              disabled={savingTimes || draftSeconds === null || draftSeconds < 0}
            >
              {savingTimes ? 'Saving…' : 'Save times'}
            </button>
          </div>
        </form>
      )}

      <div className="tracker-body">
        {isFinished && groups && (
          <p className="tracker-finished-note">
            This workout is finished — reps and weights are still editable, and edits save as you type.
          </p>
        )}
        {!groups ? (
          <p className="tracker-loading">Loading session…</p>
        ) : (
          groups.map(group => (
            <div key={group.section} className="modal-section">
              <div className="modal-section__header">
                <span className="modal-section__line" />
                <span className="modal-section__label">{group.label}</span>
                <span className="modal-section__line" />
              </div>
              {group.exercises.map(tracked => (
                <TrackerExercise
                  key={tracked.exercise.id}
                  tracked={tracked}
                  accentColor={color.solid}
                  onSetChange={(setNumber, field, value) => onSetChange(group.section, tracked.exercise.id, setNumber, field, value)}
                  onSetMetaChange={(setNumber, patch) => onSetMetaChange(group.section, tracked.exercise.id, setNumber, patch)}
                  showRpe={showRpe}
                  onCardioChange={(field, value) => onCardioChange(group.section, tracked.exercise.id, field, value)}
                  onCommitSetShadow={(setNumber, values) => onCommitSetShadow(group.section, tracked.exercise.id, setNumber, values)}
                  onCommitCardioShadow={field => onCommitCardioShadow(group.section, tracked.exercise.id, field)}
                  onSetCommit={setNumber => rest.commit(group.section, tracked.exercise.id, setNumber)}
                  onAddSet={() => onAddSet(group.section, tracked.exercise.id)}
                  onRemoveSet={setNumber => onRemoveSet(group.section, tracked.exercise.id, setNumber)}
                  onSwap={def => handleSwap(group.section, tracked.exercise.id, def)}
                  onNoteChange={note => onNoteChange(group.section, tracked.exercise.id, note)}
                  onRemove={tracked.isAdded ? () => onRemoveAddedExercise(group.section, tracked.exercise.id) : undefined}
                />
              ))}
            </div>
          ))
        )}
        {groups && (
          <label className="tracker-session-note">
            <span className="tracker-session-note__label">Session notes</span>
            <textarea
              className="tracker-input tracker-session-note__input"
              rows={2}
              maxLength={2000}
              aria-label="Session notes"
              placeholder="The session as a whole — sleep, energy, anything the coach should know"
              value={sessionNote}
              onChange={e => onSessionNoteChange(e.target.value)}
            />
          </label>
        )}
        {groups && !isFinished && (
          <button
            className="tracker-add-set"
            style={{ margin: '4px 0 16px' }}
            onClick={() => setAddingExercise(true)}
            title="Log a movement that isn't in the plan — this workout only"
          >
            <Plus size={13} strokeWidth={1.5} /> Add exercise
          </button>
        )}
        {groups && (
          <button
            className="tracker-cancel"
            onClick={() => { setConfirmCount(null); setConfirmCancel(true); }}
            disabled={isFinishing || isCancelling}
          >
            <Trash2 size={14} strokeWidth={1.5} /> Cancel workout
          </button>
        )}
      </div>

      {addingExercise && (
        <ExercisePicker
          onSelect={def => { setAddingExercise(false); onAddExercise(def); }}
          onClose={() => setAddingExercise(false)}
          restrictTo={climbing ? ADDABLE_IN_A_CLIMB : ADDABLE_CATEGORIES}
          initialCategory={climbing ? 'climbing' : undefined}
          createCategory={climbing ? 'climbing' : 'strength'}
        />
      )}

      {confirmCount !== null && !isFinishing && (
        <ConfirmBar
          tip="tracker-unlogged"
          message={`${confirmCount} planned ${confirmCount === 1 ? 'set' : 'sets'} unlogged — recorded as 0.`}
          confirmLabel="Finish anyway"
          accentColor={color.solid}
          onKeep={() => setConfirmCount(null)}
          onConfirm={() => handleFinish()}
        />
      )}

      {scoreOpen && !isFinishing && (event.scoringType === 'for-time' || event.scoringType === 'amrap') && (
        <ScorePrompt
          scoringType={event.scoringType}
          timeCapMinutes={event.timeCapMinutes}
          elapsedSeconds={elapsed}
          accentColor={color.solid}
          disabled={isFinishing}
          onSubmit={handleFinish}
        />
      )}

      {summary && groups && (
        <WorkoutSummary
          event={event}
          accentColor={color.solid}
          durationSeconds={session?.total_duration_seconds ?? null}
          groups={groups}
          sessionNote={sessionNote}
          prs={summary.prs}
          score={summary.score}
          scoreRecord={summary.scoreRecord}
          coachText={summary.coachText}
          coachStatus={summary.coachStatus}
          onClose={dismissSummary}
          onDone={() => { dismissSummary(); dispatch({ type: 'STOP_TRACKING' }); }}
          // Leaves the tracker exactly as Done does, then pins the session
          // the athlete just logged (D-C08); the summary is finished, so
          // there is nothing left to flush.
          onAskCoach={() => {
            dismissSummary();
            dispatch({ type: 'STOP_TRACKING' });
            dispatch({ type: 'ASK_COACH', payload: { kind: 'session', eventId: event.id, date: event.date, title: event.title, source: 'tracker' } });
          }}
        />
      )}

      {confirmCancel && (
        <ConfirmBar
          message="Cancel this workout? Everything logged for this session is deleted — it can't be resumed."
          confirmLabel={isCancelling ? 'Discarding…' : 'Discard workout'}
          danger
          disabled={isCancelling}
          onKeep={() => setConfirmCancel(false)}
          onConfirm={handleCancelWorkout}
        />
      )}
    </div>,
    document.body,
  );
}
