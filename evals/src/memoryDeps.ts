import type { CoachToolDeps } from '../../src/lib/coach/tools';
import { slugifyName } from '../../src/lib/schedule/definitions';
import { baseIdOf } from '../../src/lib/schedule/occurrence';
import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { CreateEventInput } from '../../src/lib/schedule/types';
import type { Meal } from '../../src/types/nutrition';

// In-memory CoachToolDeps: the real executors from src/lib/coach/tools.ts run
// against this state, so tool_result strings (including validation errors the
// model must recover from) are byte-identical to production. One deliberate
// divergence from the app: createDefinition inserts into the map
// synchronously, so entryFromDefinition resolves on the same call (the app has
// an async gap — tools.ts:121 — and falls back to building the entry inline;
// the resulting event entries are equivalent).

export interface MemoryState {
  events: WorkoutEvent[];
  definitions: Map<string, ExerciseDefinition>;
  createdDefinitionNames: string[];
  /** Same array instance as deps.meals — mutated in place so both stay live. */
  meals: Meal[];
}

export function createMemoryDeps(
  initialEvents: WorkoutEvent[],
  initialDefinitions: ExerciseDefinition[],
  initialMeals: Meal[] = [],
): { deps: CoachToolDeps; state: MemoryState } {
  const state: MemoryState = {
    events: initialEvents.map(e => ({ ...e })),
    definitions: new Map(initialDefinitions.map(d => [d.id, { ...d }])),
    createdDefinitionNames: [],
    meals: initialMeals.map(m => ({ ...m })),
  };
  let eventCounter = 0;
  let mealCounter = 0;

  const deps: CoachToolDeps = {
    async createEvent(input: CreateEventInput) {
      // Truncated tool JSON can arrive with required fields missing; the
      // production API would reject the row, so the fixture does too (executor
      // turns a null into "Failed to create the event.").
      if (!input.date || !input.title || !input.type || input.estimatedDuration == null) return null;
      eventCounter += 1;
      const id = `evt-ai-${eventCounter}`;
      state.events.push({
        id,
        type: input.type,
        title: input.title,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        estimatedDuration: input.estimatedDuration,
        description: input.description ?? '',
        exercises: input.exercises ?? [],
        warmup: input.warmup,
        cooldown: input.cooldown,
        difficulty: input.difficulty ?? 3,
        location: input.location,
        tags: input.tags ?? [],
        equipment: input.equipment,
        cardioTargets: input.cardioTargets,
        climbingTargets: input.climbingTargets,
        isCompleted: false,
        isRecurring: false,
      });
      return { id };
    },

    async updateEvent({ id, fields }) {
      const event = state.events.find(e => e.id === id);
      if (!event) return false;
      Object.assign(event, fields);
      return true;
    },

    async deleteEvent(id) {
      const before = state.events.length;
      state.events = state.events.filter(e => e.id !== id);
      return state.events.length < before;
    },

    async deleteEventInstance(baseId, date) {
      // Occurrence rows aren't expanded in fixtures; deleting an instance of a
      // recurring base is recorded as success if the base exists.
      return state.events.some(e => baseIdOf(e.id) === baseId || e.id === baseId) && date.length > 0;
    },

    async rescheduleEvent(id, fields) {
      const base = state.events.find(e => e.id === baseIdOf(id));
      if (!base) return false;
      if (fields.date || fields.startTime || fields.endTime) return true;
      return true;
    },

    definitions: state.definitions,

    async createDefinition(input) {
      const id = input.id ?? slugifyName(input.canonicalName);
      state.definitions.set(id, {
        id,
        canonicalName: input.canonicalName,
        aliases: input.aliases ?? [],
        category: input.category,
        muscleGroups: input.muscleGroups ?? [],
        equipment: input.equipment ?? [],
        imageUrl: input.imageUrl,
        techniqueNotes: input.techniqueNotes,
        isUnilateral: input.isUnilateral ?? false,
        defaultSets: input.defaultSets,
        defaultReps: input.defaultReps,
        defaultDuration: input.defaultDuration,
        defaultWeight: input.defaultWeight,
        defaultRest: input.defaultRest,
      });
      state.createdDefinitionNames.push(input.canonicalName);
      return { id };
    },

    async updateDefinition({ id, fields }) {
      const def = state.definitions.get(id);
      if (!def) return false;
      if (fields.canonicalName && fields.canonicalName !== def.canonicalName) {
        def.aliases = [...def.aliases, def.canonicalName];
      }
      Object.assign(def, fields);
      return true;
    },

    meals: state.meals,

    async createMeal(input) {
      // Mirror the createEvent guard: rows the production API would reject
      // (NOT NULL title/date) fail here too, so the executor returns its
      // "Failed to log the meal." path.
      if (!input.title || !input.date) return null;
      mealCounter += 1;
      const id = `meal-ai-${mealCounter}`;
      const { triggeredBy: _triggeredBy, ...fields } = input;
      state.meals.push({ ...fields, id });
      return { id };
    },

    async updateMeal({ id, fields }) {
      const meal = state.meals.find(m => m.id === id);
      if (!meal) return false;
      Object.assign(meal, fields);
      return true;
    },

    async deleteMeal(id) {
      const index = state.meals.findIndex(m => m.id === id);
      if (index === -1) return false;
      // Splice, not filter: deps.meals and state.meals share this array.
      state.meals.splice(index, 1);
      return true;
    },
  };

  return { deps, state };
}
