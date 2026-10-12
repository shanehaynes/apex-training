import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TrackerExercise from '../TrackerExercise';
import { buildTrackerModel } from '../../../lib/tracking/plan';
import type { ExerciseDefinition } from '../../../types/workout';

// Markup-level, like WorkoutSummary.test.tsx (no DOM environment here): the
// states the library definition drives — its log fields and its subtitle.

const lib = vi.hoisted(() => ({ definitions: new Map<string, unknown>() }));
vi.mock('../../../context/schedule', () => ({
  useSchedule: () => ({ definitions: lib.definitions, updateDefinition: async () => true }),
}));

function render(def: Partial<ExerciseDefinition> | null, sessionNote = '') {
  lib.definitions = new Map(def ? [['ring-pull-up', {
    id: 'ring-pull-up', canonicalName: 'Ring Pull-Up', aliases: [], category: 'strength',
    muscleGroups: [], equipment: [], isUnilateral: false, ...def,
  }]] : []);
  const tracked = buildTrackerModel({
    id: 'evt', title: 'Pull day', date: '2026-10-10', type: 'weights',
    exercises: [{ id: 'ring-pull-up', name: 'Ring Pull-Up', category: 'strength', definitionId: 'ring-pull-up', sets: 2, reps: '8' }],
  } as Parameters<typeof buildTrackerModel>[0])[0].exercises[0];
  return renderToStaticMarkup(
    <TrackerExercise
      tracked={{ ...tracked, sessionNote }}
      accentColor="#123456"
      onSetChange={() => {}}
      onCardioChange={() => {}}
      onCommitSetShadow={() => {}}
      onCommitCardioShadow={() => {}}
      onAddSet={() => {}}
      onRemoveSet={() => {}}
      onSwap={() => {}}
      onNoteChange={() => {}}
    />,
  );
}

describe('TrackerExercise — library-driven fields', () => {
  it('offers + weight when neither the plan nor the library logs it', () => {
    const html = render({});
    expect(html).toContain('aria-label="Track weight for Ring Pull-Up"');
    expect(html).not.toContain('aria-label="Set 1 weight"');
  });

  it('gives every set a weight input once the library says the movement takes one', () => {
    const html = render({ logFields: ['weight'] });
    expect(html).toContain('aria-label="Set 1 weight"');
    expect(html).toContain('aria-label="Set 2 weight"');
    expect(html).not.toContain('aria-label="Track weight for Ring Pull-Up"');
  });

  it('shows the library subtitle as an editable line, and a header pencil when there is none', () => {
    const withSubtitle = render({ techniqueNotes: 'False grip, rings at chest height' });
    expect(withSubtitle).toContain('False grip, rings at chest height');
    expect(withSubtitle).toContain('aria-label="Edit subtitle for Ring Pull-Up"');
    expect(withSubtitle).not.toContain('aria-label="Add a subtitle for Ring Pull-Up"');

    const without = render({});
    expect(without).toContain('aria-label="Add a subtitle for Ring Pull-Up"');
  });

  it('has no subtitle control for an exercise outside the library', () => {
    const html = render(null);
    expect(html).not.toContain('subtitle for Ring Pull-Up');
  });

  it('shows a saved note for this workout open, and the + note chip otherwise', () => {
    expect(render({}, 'blue band')).toContain('blue band</textarea>');
    expect(render({}, 'blue band')).not.toContain('aria-label="Add a note on Ring Pull-Up for this workout"');
    expect(render({})).toContain('aria-label="Add a note on Ring Pull-Up for this workout"');
  });
});
