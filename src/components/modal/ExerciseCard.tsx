import { useCalendar } from '../../context/CalendarContext';
import { ascentStyleLabel, climbStyleLabel } from '../../lib/climbing';
import { countSpecNote, stripCountSpec } from '../../lib/schedule/definitions';
import type { Exercise } from '../../types/workout';

interface Props {
  exercise: Exercise;
  accentColor: string;
}

export default function ExerciseCard({ exercise, accentColor }: Props) {
  const { dispatch } = useCalendar();
  const meta: string[] = [];
  if (exercise.category === 'climbing') {
    // A pitch: its whole prescription is the discipline, grade, and ascent.
    meta.push(climbStyleLabel(exercise.climbStyle));
    if (exercise.grade) meta.push(exercise.grade);
    const ascent = ascentStyleLabel(exercise.ascentStyle);
    if (ascent) meta.push(ascent);
  } else {
    // Side conventions ride below with the notes, not in the prescription.
    const reps = stripCountSpec(exercise.reps);
    const duration = stripCountSpec(exercise.duration);
    if (exercise.sets && reps) meta.push(`${exercise.sets} × ${reps}`);
    else if (exercise.sets) meta.push(`${exercise.sets} sets`);
    else if (reps) meta.push(reps);
    if (duration) meta.push(duration);
    if (exercise.weight) meta.push(exercise.weight);
    if (exercise.restPeriod) meta.push(`Rest ${exercise.restPeriod}`);
  }
  const specNote = exercise.category === 'climbing' ? undefined : countSpecNote(exercise);

  return (
    <div className="exercise-card">
      {exercise.imageUrl && (
        <img
          src={exercise.imageUrl}
          alt={exercise.name}
          className="exercise-card__img"
          loading="lazy"
          width={80}
          height={80}
        />
      )}
      <div className="exercise-card__content">
        {exercise.definitionId ? (
          <button
            className="exercise-card__name exercise-card__name--link"
            onClick={() => dispatch({ type: 'OPEN_LIBRARY', payload: exercise.definitionId })}
            title="Open in exercise library"
          >
            {exercise.name}
          </button>
        ) : (
          <span className="exercise-card__name">{exercise.name}</span>
        )}
        {meta.length > 0 && (
          <span className="exercise-card__meta" style={{ color: accentColor }}>
            {meta.join('  ·  ')}
          </span>
        )}
        {specNote && <span className="exercise-card__notes">{specNote}</span>}
        {exercise.notes && <span className="exercise-card__notes">{exercise.notes}</span>}
        {exercise.muscleGroups && exercise.muscleGroups.length > 0 && (
          <div className="exercise-card__muscles">
            {exercise.muscleGroups.map(m => <span key={m} className="exercise-card__muscle-tag">{m}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
