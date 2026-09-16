import type { McpToolDef } from '../protocol.js';
import { optionalBoolean, optionalInt } from '../args.js';
import { aliasIndexOf, fetchDefinitionRows, fetchLastPerformedRows } from '../data.js';
import { fetchAllPages } from '../../pagination.js';
import type { WorkoutEventRow } from '../../../../src/lib/db/types.js';
import { rowToEvent } from '../../../../src/lib/schedule/mapping.js';
import { countDefinitionReferences } from '../../../../src/lib/schedule/definitions.js';
import { lastPerformedByCanonical } from '../../../../src/lib/library/stats.js';

// Exercise-library search: lets the model resolve "incline press" to the
// canonical entry (and its aliases) before querying history.
//
// W10 widened the entries with `id` (the phone's editor PATCHes
// `/api/exercise-definitions?id=`) and an opt-in `references` count — the
// web library's "in N workouts", which it derives from every loaded event
// (countDefinitionReferences) and the phone, holding only a window of the
// schedule, cannot. The limit ceiling rose with it: the phone decorates its
// whole library in one call.

export const searchExercisesTool: McpToolDef = {
  name: 'search_exercises',
  description:
    'Search the exercise library by name or alias (case-insensitive substring). Empty query lists all. ' +
    'Returns canonical names to use with get_exercise_history, plus default prescriptions and last-performed dates. ' +
    'Set include_references true for the number of planned workouts each exercise appears in.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Substring to match against names and aliases. Optional.' },
      include_archived: { type: 'boolean', description: 'Include archived definitions (default false).' },
      include_references: { type: 'boolean', description: 'Count the planned workouts each exercise appears in (default false).' },
      limit: { type: 'integer', description: 'Max results (default 25, max 500).' },
    },
  },
  async run(supabase, userId, args) {
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const includeArchived = optionalBoolean(args, 'include_archived', false);
    const includeReferences = optionalBoolean(args, 'include_references', false);
    const limit = optionalInt(args, 'limit', 25, 1, 500);

    const defs = await fetchDefinitionRows(supabase, userId);
    const aliasIndex = aliasIndexOf(defs);

    // Last-performed dates, aggregated server-side (one row per name per log
    // table) rather than paged through every logged (name, date) pair.
    const lastPerformed = lastPerformedByCanonical(
      await fetchLastPerformedRows(supabase, userId),
      aliasIndex.toCanonical,
    );

    // A series counts once (occurrences collapse to their base), so the base
    // rows are enough — no expansion needed.
    let references: Map<string, number> | null = null;
    if (includeReferences) {
      const eventRows = await fetchAllPages<WorkoutEventRow>('workout_events', (from, to) =>
        supabase.from('workout_events').select('*').eq('user_id', userId).order('date', { ascending: true }).range(from, to),
      );
      const events = eventRows.map(rowToEvent);
      references = new Map(defs.map(d => [d.id, countDefinitionReferences(d.id, events)]));
    }

    const matches = defs
      .filter(d => includeArchived || !d.archived_at)
      .filter(d => {
        if (!query) return true;
        if (d.canonical_name.toLowerCase().includes(query)) return true;
        return (d.aliases ?? []).some(a => a.toLowerCase().includes(query));
      })
      .slice(0, limit)
      .map(d => ({
        id: d.id,
        canonical_name: d.canonical_name,
        category: d.category,
        aliases: d.aliases ?? [],
        muscle_groups: d.muscle_groups ?? [],
        equipment: d.equipment ?? [],
        is_unilateral: d.is_unilateral,
        default_prescription: {
          sets: d.default_sets,
          reps: d.default_reps,
          duration: d.default_duration,
          weight: d.default_weight,
          rest: d.default_rest,
        },
        technique_notes: d.technique_notes ?? null,
        last_performed: lastPerformed.get(d.canonical_name) ?? null,
        archived: Boolean(d.archived_at),
        ...(references ? { references: references.get(d.id) ?? 0 } : {}),
      }));

    return { query: query || null, total_matches: matches.length, exercises: matches };
  },
};
