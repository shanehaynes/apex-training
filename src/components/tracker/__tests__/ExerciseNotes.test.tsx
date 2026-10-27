import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ExerciseNotes, { type NoteSection } from '../ExerciseNotes';

// Markup-level, like TrackerExercise.test.tsx: the panel's closed and open states.

function render(opts: { everyTime?: string; thisWorkout?: string; canEdit?: boolean; inLibrary?: boolean; editing?: NoteSection | null }) {
  return renderToStaticMarkup(
    <ExerciseNotes
      exerciseName="Overhead Squat"
      everyTime={opts.everyTime ?? ''}
      canEditEveryTime={opts.canEdit ?? true}
      inLibrary={opts.inLibrary ?? true}
      onSaveEveryTime={() => {}}
      thisWorkout={opts.thisWorkout ?? ''}
      onThisWorkoutChange={() => {}}
      editing={opts.editing ?? null}
      onEdit={() => {}}
      onDone={() => {}}
    />,
  );
}

describe('ExerciseNotes', () => {
  it('renders nothing closed with no notes (the card offers the chip)', () => {
    expect(render({})).toBe('');
  });

  it('reads as both notes, each labelled, when closed', () => {
    const html = render({ everyTime: 'Slow descent', thisWorkout: 'wrists tight' });
    expect(html).toContain('Every time');
    expect(html).toContain('Slow descent');
    expect(html).toContain('This workout only');
    expect(html).toContain('wrists tight');
    expect(html).not.toContain('<textarea');
  });

  it('opens on two textareas, the every-time one carrying the library note', () => {
    const html = render({ everyTime: 'Slow descent', editing: 'everyTime' });
    expect(html).toContain('aria-label="Note on Overhead Squat for every workout"');
    expect(html).toContain('Slow descent</textarea>');
    expect(html).toContain('aria-label="Note on Overhead Squat for this workout only"');
    expect(html).toContain('saved to the exercise, shows in every workout');
    expect(html).toContain('>Done</button>');
  });

  it('shows the every-time note read-only when the exercise is not in the library', () => {
    const html = render({ everyTime: 'From the plan', canEdit: false, inLibrary: false, editing: 'thisWorkout' });
    expect(html).not.toContain('for every workout"');
    expect(html).toContain('From the plan');
    expect(html).toContain('not in your library, read-only');
  });

  it("says the library didn't load, not that the exercise is missing from it", () => {
    const html = render({ everyTime: 'From the plan', canEdit: false, inLibrary: true, editing: 'thisWorkout' });
    expect(html).not.toContain('not in your library');
    expect(html).toContain("library didn&#x27;t load, read-only");
  });

  it('treats a whitespace-only every-time note as none', () => {
    const html = render({ everyTime: '   ', thisWorkout: 'wrists tight' });
    expect(html).not.toContain('Every time');
    expect(html).toContain('aria-label="Add a note on Overhead Squat for every workout"');
  });
});
