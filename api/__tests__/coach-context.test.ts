import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseISO } from 'date-fns';
import { buildChatContext, ChatContextError, isChatMode } from '../_lib/coach/context';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../_lib/mcp/data';
import { loadMealsForDate } from '../_lib/trackerSession';
import {
  buildAnalyticsPrompt, buildBuilderPrompt, buildStablePrompt, buildSystemPrompt, buildVolatileContext,
} from '../../src/lib/coach/prompt';
import { describeDraft, draftFromTemplate } from '../../src/lib/builder/draft';
import { describeChartDraft, emptyChartDraft } from '../../src/lib/analytics/draft';
import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';

// Golden equivalence: the server must produce exactly the text the browser
// used to build from the same inputs — that is what lets the evals (which
// drive src/lib/coach/prompt.ts directly) keep standing for both clients.

vi.mock('../_lib/mcp/data.js', () => ({
  fetchExpandedSchedule: vi.fn(),
  fetchCompletionsInRange: vi.fn(async () => []),
}));
vi.mock('../_lib/trackerSession.js', () => ({ loadMealsForDate: vi.fn(async () => []) }));
vi.mock('../_lib/reviewData.js', () => ({ fetchPeriodInputs: vi.fn() }));
// The physiology inputs are scripted (their own suite is coach-physiology.test.ts);
// compute + describe run for real, so the block in `volatile` is the production text.
vi.mock('../_lib/coach/physiology.js', () => ({
  fetchPhysiologyInputs: vi.fn(async (_db: unknown, _u: string, today: string) =>
    ({ today, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null })),
}));
import { fetchPhysiologyInputs } from '../_lib/coach/physiology';
import { computePhysiology, describePhysiology } from '../../src/lib/physiology';

const TODAY = '2026-09-03'; // a Thursday

const def: ExerciseDefinition = {
  id: 'def-1', canonicalName: 'Bench Press', aliases: [], category: 'strength',
  muscleGroups: ['chest'], equipment: [], isUnilateral: false,
};
const base: WorkoutEvent = {
  id: 'evt-today', type: 'weights', title: 'Push Day', date: TODAY, startTime: '17:30', estimatedDuration: 60,
  description: '', exercises: [], difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
};
const occurrences: WorkoutEvent[] = [
  { ...base, id: 'evt-old', title: 'Long Run', type: 'cardio', sport: 'running', date: '2026-08-11' },  // 3+ weeks back
  { ...base, id: 'evt-soccer', title: ' Soccer night ', type: 'cardio', sport: 'other', date: '2026-08-31' },
  base,
  { ...base, id: 'evt-next', title: 'Deload', date: '2026-10-20' }, // outside the window
];
const meal: Meal = { id: 'meal-1', title: 'Oats', date: TODAY, time: '07:30', mealType: 'breakfast', proteinG: 20, carbsG: 60, fatTotalG: 10, notes: '' } as Meal;

interface AdminState { profile: Record<string, unknown> | null; blocks: unknown[]; templates: Array<{ title: string }> }
let state: AdminState;

function makeAdmin() {
  return {
    from(table: string) {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain, order: () => chain,
        maybeSingle: async () => ({ data: state.profile, error: null }),
        then(resolve: (v: unknown) => void) {
          const data = table === 'training_blocks' ? state.blocks : table === 'workout_templates' ? state.templates : [];
          resolve({ data, error: null });
        },
      };
      return chain;
    },
  } as never;
}

beforeEach(() => {
  state = { profile: { coach_goal: 'Send 5.12', coach_context: 'Two kids' }, blocks: [], templates: [{ title: 'Push Day' }, { title: 'Pull Day' }] };
  vi.mocked(fetchExpandedSchedule).mockResolvedValue({ occurrences, definitions: new Map([[def.id, def]]), anchorDates: new Map() });
  vi.mocked(fetchCompletionsInRange).mockResolvedValue([
    { event_id: 'evt-soccer', event_date: '2026-08-31', is_completed: true, completed_at: '2026-08-31T20:00:00Z' },
  ] as never);
  vi.mocked(loadMealsForDate).mockResolvedValue([meal]);
});

describe('buildChatContext', () => {
  it('rejects a malformed today and non-object drafts with a caller-fixable error', async () => {
    await expect(buildChatContext(makeAdmin(), 'u1', 'chat', '09/03/2026')).rejects.toBeInstanceOf(ChatContextError);
    await expect(buildChatContext(makeAdmin(), 'u1', 'builder', TODAY, 'not a draft')).rejects.toBeInstanceOf(ChatContextError);
    await expect(buildChatContext(makeAdmin(), 'u1', 'analytics', TODAY, undefined)).rejects.toBeInstanceOf(ChatContextError);
    expect(isChatMode('builder')).toBe(true);
    expect(isChatMode('tools')).toBe(false);
  });

  it('chat: splits into the stable prompt and the live context, which together equal the one-string prompt', async () => {
    const { system, volatile, toolContext } = await buildChatContext(makeAdmin(), 'u1', 'chat', TODAY);

    // What ChatSidebar used to assemble: the expanded schedule with completion
    // flags applied, today's events, today's meals, the profile fields.
    const withCompletion = occurrences.map(e => e.id === 'evt-soccer' ? { ...e, isCompleted: true, completedAt: '2026-08-31T20:00:00Z' } : e);
    const windowed = withCompletion.filter(e => e.date >= '2026-08-03' && e.date <= '2026-09-06');
    const todayEvents = withCompletion.filter(e => e.date === TODAY);
    const athlete = { goal: 'Send 5.12', context: 'Two kids' };
    expect(system).toBe(buildStablePrompt([def]));
    expect(volatile).toBe(buildVolatileContext(todayEvents, windowed, parseISO(TODAY), athlete, null, [meal]));
    // The compatibility shape the evals drive is exactly the two halves joined.
    expect(system + '\n\n' + volatile).toBe(
      buildSystemPrompt(todayEvents, windowed, parseISO(TODAY), [def], athlete, null, [meal]),
    );

    // The stable half carries the library and nothing that changes per turn.
    expect(system).toContain('EXERCISE LIBRARY (canonical names):\nBench Press');
    expect(system).not.toContain('Today:');
    expect(system).not.toContain('[evt-today]');
    expect(system).not.toContain('Send 5.12');

    expect(volatile).toContain('[evt-today] Push Day (60 min) at 17:30');
    // Aug 31 is THIS week (Mon-anchored), so it shows as done there; the
    // past-4-weeks window holds only the Aug 11 run.
    expect(volatile).toContain('✓ [evt-soccer] Mon Aug 31 — Soccer night (60 min)');
    expect(volatile).toContain('LAST 4 WEEKS: 0/1 completed (0%)');
    expect(volatile).toContain('[meal-1] Oats');
    expect(volatile).toContain('Goal: Send 5.12');
    expect(volatile).not.toContain('Deload');
    // Label context sees every occurrence (a tool may reference any id).
    expect(toolContext.events.map(e => e.id)).toContain('evt-next');
    expect(toolContext.definitions.get('def-1')).toEqual(def);
    expect(fetchCompletionsInRange).toHaveBeenCalledWith(expect.anything(), 'u1', '2026-08-03', '2026-09-06');
  });

  it('chat: the physiology panel rides in the live half, computed from the fetched inputs', async () => {
    const inputs = {
      today: TODAY, activities: [], thresholdHr: 162, maxHr: 190,
      cardioLogs: [{ eventId: 'evt-c', eventDate: '2026-09-01', avgHeartRate: 140, durationMinutes: 45 }],
      setLogs: [{ eventDate: '2026-09-02', actualWeight: '225', actualReps: '5', actualDuration: null, isAutofilled: false }],
    };
    vi.mocked(fetchPhysiologyInputs).mockResolvedValueOnce(inputs as never);
    const { system, volatile } = await buildChatContext(makeAdmin(), 'u1', 'chat', TODAY);
    const panel = describePhysiology(computePhysiology(inputs as never));
    expect(panel).toContain('<physiology>');
    expect(volatile).toContain(panel);
    expect(fetchPhysiologyInputs).toHaveBeenCalledWith(expect.anything(), 'u1', TODAY);
    // Never in the cached prefix.
    expect(system).not.toContain('physiology');
    expect(system).toBe(buildStablePrompt([def]));
  });

  it('chat: a physiology failure costs the panel and nothing else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetchPhysiologyInputs).mockRejectedValueOnce(new Error('activity_streams is on fire'));
    const { volatile } = await buildChatContext(makeAdmin(), 'u1', 'chat', TODAY);
    expect(volatile).not.toContain('<physiology>');
    expect(volatile).toContain('[evt-today] Push Day (60 min) at 17:30');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('physiology panel unavailable'), 'activity_streams is on fire');
    warn.mockRestore();
  });

  it('chat: a missing profile degrades to the generic live context', async () => {
    state.profile = null;
    const { system, volatile } = await buildChatContext(makeAdmin(), 'u1', 'chat', TODAY);
    expect(volatile).not.toContain('<athlete_profile>');
    // The stable half never carried it: a profile edit must not touch the cached prefix.
    expect(system).toBe(buildStablePrompt([def]));
  });

  it('builder: describes the draft with the saved-workout titles and the library', async () => {
    const draft = draftFromTemplate({
      id: 'wt-1', title: 'Push Day', type: 'weights', tags: [], description: '', estimatedDuration: 60,
      difficulty: 3, exercises: [], scoringType: 'strength',
    } as never, TODAY);
    const { system, volatile, toolContext } = await buildChatContext(makeAdmin(), 'u1', 'builder', TODAY, draft);
    expect(system).toBe(buildBuilderPrompt(describeDraft(draft), ['Push Day', 'Pull Day'], [def], parseISO(TODAY)));
    expect(system).toContain('SAVED WORKOUTS: Push Day · Pull Day');
    // Single-block prompt: nothing to inject per turn.
    expect(volatile).toBe('');
    expect(toolContext.events).toEqual([]);
  });

  it('analytics: describes the chart draft with the trimmed, distinct "other sport" titles', async () => {
    const draft = emptyChartDraft();
    const { system, volatile } = await buildChatContext(makeAdmin(), 'u1', 'analytics', TODAY, draft);
    expect(system).toBe(buildAnalyticsPrompt(describeChartDraft(draft), ['Soccer night'], parseISO(TODAY)));
    expect(system).toContain('WORKOUTS MARKED "OTHER SPORT": Soccer night');
    expect(volatile).toBe('');
  });
});
