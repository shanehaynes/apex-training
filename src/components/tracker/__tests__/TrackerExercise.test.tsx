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

  it('shows the every-time note (the library technique notes) labelled and tappable to edit', () => {
    const html = render({ techniqueNotes: 'False grip, rings at chest height' });
    expect(html).toContain('False grip, rings at chest height');
    expect(html).toContain('Every time');
    expect(html).toContain('aria-label="Edit the every-time note on Ring Pull-Up"');
    // The other kind can still be added from the panel.
    expect(html).toContain('aria-label="Add a note on Ring Pull-Up for this workout"');
    expect(html).not.toContain('aria-label="Add a note on Ring Pull-Up"');
  });

  it('shows the note for this workout labelled, with a way to add the every-time one', () => {
    const html = render({}, 'blue band');
    expect(html).toContain('This workout only');
    expect(html).toContain('blue band');
    expect(html).toContain('aria-label="Edit the note on Ring Pull-Up for this workout"');
    expect(html).toContain('aria-label="Add a note on Ring Pull-Up for every workout"');
  });

  it('offers one + note chip when there is no note of either kind', () => {
    const html = render({});
    expect(html).toContain('aria-label="Add a note on Ring Pull-Up"');
    expect(html).not.toContain('Every time');
  });

  it('offers no every-time note for an exercise outside the library', () => {
    const html = render(null);
    expect(html).not.toContain('aria-label="Add a note on Ring Pull-Up for every workout"');
    expect(html).toContain('aria-label="Add a note on Ring Pull-Up"');
  });
});
