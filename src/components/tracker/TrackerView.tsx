import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, CheckCircle2, Flag, Trash2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { useMeals } from '../../context/MealsContext';
import { formatElapsed } from '../../lib/time';
import { notify } from '../../lib/notify';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useWorkoutSession } from '../../hooks/useWorkoutSession';
import type { TrackedSection } from '../../lib/db/types';
import type { ExerciseDefinition } from '../../types/workout';
import TrackerExercise from './TrackerExercise';
import WorkoutSummary from './WorkoutSummary';
import ConfirmBar from './ConfirmBar';

export default function TrackerView() {
  const { state, dispatch } = useCalendar();
  const { setCompletion } = useSchedule();
  const { getMealsForDate } = useMeals();
  const event = state.trackingSession;

  const {
    groups, session, elapsed, isFinished, isFinishing, isCancelling, summary,
    onSetChange, onCardioChange, onCommitSetShadow, onCommitCardioShadow, onAddSet, onRemoveSet,
    onSwapExercise, flushSave, requestFinish, cancelWorkout, openSavedSummary, dismissSummary,
  } = useWorkoutSession(event, setCompletion, getMealsForDate);

  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const color = event ? getWorkoutColor(event.type) : null;
  if (!event || !color) return null;

  const close = async () => {
    await flushSave();
    dispatch({ type: 'STOP_TRACKING' });
  };

  const handleFinish = async () => {
    // A visible confirm bar means the user already saw the unlogged count —
    // the next press (header button or "Finish anyway") finishes for real.
    const result = await requestFinish(confirmCount !== null);
    if (result.status === 'needs-confirm') {
      setConfirmCancel(false);
      setConfirmCount(result.count);
    } else {
      setConfirmCount(null);
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

  return createPortal(
    <div className="tracker">
      <header className="tracker-header" style={{ borderBottom: `2px solid ${color.solid}` }}>
        <button className="tracker-header__back" onClick={close} aria-label="Back to calendar">
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>
        <div className="tracker-header__titles">
          <span className="tracker-header__title">{event.title}</span>
          <span className="tracker-header__date">{format(parseISO(event.date), 'EEEE, MMM d')}</span>
        </div>
        <span className={`tracker-header__timer${isFinished ? ' tracker-header__timer--done' : ''}`}>
          {formatElapsed(elapsed)}
        </span>
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
            onClick={handleFinish}
            disabled={!groups || isFinishing}
          >
            <Flag size={14} strokeWidth={2} /> Finish
          </button>
        )}
      </header>

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
                  onCardioChange={(field, value) => onCardioChange(group.section, tracked.exercise.id, field, value)}
                  onCommitSetShadow={(setNumber, values) => onCommitSetShadow(group.section, tracked.exercise.id, setNumber, values)}
                  onCommitCardioShadow={field => onCommitCardioShadow(group.section, tracked.exercise.id, field)}
                  onAddSet={() => onAddSet(group.section, tracked.exercise.id)}
                  onRemoveSet={setNumber => onRemoveSet(group.section, tracked.exercise.id, setNumber)}
                  onSwap={def => handleSwap(group.section, tracked.exercise.id, def)}
                />
              ))}
            </div>
          ))
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

      {confirmCount !== null && !isFinishing && (
        <ConfirmBar
          message={`${confirmCount} planned ${confirmCount === 1 ? 'set' : 'sets'} unlogged — recorded as 0.`}
          confirmLabel="Finish anyway"
          accentColor={color.solid}
          onKeep={() => setConfirmCount(null)}
          onConfirm={handleFinish}
        />
      )}

      {summary && groups && (
        <WorkoutSummary
          event={event}
          accentColor={color.solid}
          durationSeconds={session?.total_duration_seconds ?? null}
          groups={groups}
          prs={summary.prs}
          coachText={summary.coachText}
          coachStatus={summary.coachStatus}
          onClose={dismissSummary}
          onDone={() => { dismissSummary(); dispatch({ type: 'STOP_TRACKING' }); }}
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
