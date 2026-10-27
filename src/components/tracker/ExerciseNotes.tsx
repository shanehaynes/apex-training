import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import '../../styles/tracker-notes.css';

/** Which of the two notes a tap asked to edit, so its field takes the focus. */
export type NoteSection = 'everyTime' | 'thisWorkout';

interface Props {
  exerciseName: string;
  /** The library definition's technique notes: shown with this movement in
   *  every workout. */
  everyTime: string;
  /** False when there is no loaded library definition to write to, so the
   *  every-time note (if the plan carries one) is read-only. */
  canEditEveryTime: boolean;
  /** The plan entry names a library movement, even if its definition did not
   *  load: the read-only hint then says the library is unavailable rather
   *  than that the exercise is not in it. */
  inLibrary: boolean;
  onSaveEveryTime: (next: string) => void;
  /** This occurrence's note (workout_exercise_notes) — rides the tracker's save. */
  thisWorkout: string;
  onThisWorkoutChange: (next: string) => void;
  /** Set to a section to open the editor on it; null keeps it closed. */
  editing: NoteSection | null;
  onEdit: (section: NoteSection) => void;
  onDone: () => void;
}

// The every-time note is long-form technique text (the library editor's
// "Technique notes"), so the tracker caps it like the day-only note.
const MAX_NOTE = 2000;

/**
 * The exercise's notes, in two labelled sections: "Every time" is saved to the
 * exercise in the library and shows in every workout; "This workout only"
 * stays with today's session. Closed, it reads as the notes themselves and a
 * tap on either opens the editor on that one; with no notes at all the card's
 * "+ note" chip opens it instead (the parent renders that chip).
 */
export default function ExerciseNotes({
  exerciseName,
  everyTime,
  canEditEveryTime,
  inLibrary,
  onSaveEveryTime,
  thisWorkout,
  onThisWorkoutChange,
  editing,
  onEdit,
  onDone,
}: Props) {
  // The every-time draft is local until it is committed (blur or Done), since
  // each commit is a library write; the day-only note is live, like the sets.
  const [draft, setDraft] = useState<string | null>(null);
  const open = editing !== null;
  // The section that was tapped takes the focus; the editor mounts on open.
  const focusEvery = editing === 'everyTime' && canEditEveryTime;

  const commit = () => {
    if (draft === null || !canEditEveryTime) return;
    const next = draft.trim();
    if (next !== everyTime) onSaveEveryTime(next);
  };

  const done = () => {
    commit();
    setDraft(null);
    onDone();
  };

  const hasEvery = !!everyTime.trim();
  const hasToday = !!thisWorkout.trim();
  const readOnlyHint = inLibrary ? "library didn't load, read-only" : 'not in your library, read-only';

  if (!open) {
    if (!hasEvery && !hasToday) return null;
    return (
      <div className="tracker-notes" role="group" aria-label={`Notes on ${exerciseName}`}>
        {hasEvery && (
          <button
            type="button"
            className="tracker-notes__read"
            onClick={() => onEdit('everyTime')}
            disabled={!canEditEveryTime}
            aria-label={canEditEveryTime ? `Edit the every-time note on ${exerciseName}` : undefined}
            title={canEditEveryTime ? 'Saved to the exercise — shows in every workout' : readOnlyHint}
          >
            <span className="tracker-notes__label">
              Every time {canEditEveryTime && <Pencil size={10} strokeWidth={1.5} aria-hidden="true" />}
            </span>
            <span className="tracker-notes__text">{everyTime}</span>
          </button>
        )}
        {hasToday && (
          <button
            type="button"
            className="tracker-notes__read"
            onClick={() => onEdit('thisWorkout')}
            aria-label={`Edit the note on ${exerciseName} for this workout`}
            title="Stays with this workout only"
          >
            <span className="tracker-notes__label">
              This workout only <Pencil size={10} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <span className="tracker-notes__text">{thisWorkout}</span>
          </button>
        )}
        {(!hasToday || (!hasEvery && canEditEveryTime)) && (
          <div className="tracker-notes__adds">
            {!hasEvery && canEditEveryTime && (
              <button
                type="button"
                className="tracker-add-set"
                onClick={() => onEdit('everyTime')}
                aria-label={`Add a note on ${exerciseName} for every workout`}
              >
                <Plus size={13} strokeWidth={1.5} /> every-time note
              </button>
            )}
            {!hasToday && (
              <button
                type="button"
                className="tracker-add-set"
                onClick={() => onEdit('thisWorkout')}
                aria-label={`Add a note on ${exerciseName} for this workout`}
              >
                <Plus size={13} strokeWidth={1.5} /> note for today
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tracker-notes tracker-notes--open" role="group" aria-label={`Notes on ${exerciseName}`}>
      {(canEditEveryTime || hasEvery) && (
        <label className="tracker-notes__field">
          <span className="tracker-notes__label">
            Every time
            <span className="tracker-notes__hint">
              {canEditEveryTime ? 'saved to the exercise, shows in every workout' : readOnlyHint}
            </span>
          </span>
          {canEditEveryTime ? (
            <textarea
              autoFocus={focusEvery}
              className="tracker-input tracker-notes__input"
              rows={3}
              maxLength={MAX_NOTE}
              aria-label={`Note on ${exerciseName} for every workout`}
              placeholder="e.g. slow descent, pause at the bottom, torso upright"
              value={draft ?? everyTime}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Escape') setDraft(null); }}
            />
          ) : (
            <span className="tracker-notes__text">{everyTime}</span>
          )}
        </label>
      )}
      <label className="tracker-notes__field">
        <span className="tracker-notes__label">
          This workout only
          <span className="tracker-notes__hint">stays with today's session</span>
        </span>
        <textarea
          autoFocus={open && !focusEvery}
          className="tracker-input tracker-notes__input"
          rows={2}
          maxLength={MAX_NOTE}
          aria-label={`Note on ${exerciseName} for this workout only`}
          placeholder="e.g. left shoulder pinchy on set 3"
          value={thisWorkout}
          onChange={e => onThisWorkoutChange(e.target.value)}
        />
      </label>
      <div className="tracker-notes__actions">
        <button type="button" className="tracker-add-set tracker-notes__done" onClick={done}>
          Done
        </button>
      </div>
    </div>
  );
}
