import { useCalendar } from '../../context/CalendarContext';
import type { Exercise } from '../../types/workout';

interface Props {
  exercise: Exercise;
  accentColor: string;
}

export default function ExerciseCard({ exercise, accentColor }: Props) {
  const { dispatch } = useCalendar();
  const meta: string[] = [];
  if (exercise.sets && exercise.reps) meta.push(`${exercise.sets} × ${exercise.reps}`);
  else if (exercise.sets) meta.push(`${exercise.sets} sets`);
  else if (exercise.reps) meta.push(exercise.reps);
  if (exercise.duration) meta.push(exercise.duration);
  if (exercise.weight) meta.push(exercise.weight);
  if (exercise.restPeriod) meta.push(`Rest ${exercise.restPeriod}`);

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
