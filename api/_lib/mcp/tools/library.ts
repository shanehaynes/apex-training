import type { McpToolDef } from '../protocol.js';
import { optionalBoolean, optionalInt } from '../args.js';
import { aliasIndexOf, fetchDefinitionRows } from '../data.js';
import { fetchAllPages } from '../../pagination.js';
import { lastPerformedByCanonical, type NameDateRow } from '../../../../src/lib/library/stats.js';

// Exercise-library search: lets the model resolve "incline press" to the
// canonical entry (and its aliases) before querying history.

export const searchExercisesTool: McpToolDef = {
  name: 'search_exercises',
  description:
    'Search the exercise library by name or alias (case-insensitive substring). Empty query lists all. ' +
    'Returns canonical names to use with get_exercise_history, plus default prescriptions and last-performed dates.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Substring to match against names and aliases. Optional.' },
      include_archived: { type: 'boolean', description: 'Include archived definitions (default false).' },
      limit: { type: 'integer', description: 'Max results (default 25, max 100).' },
    },
  },
  async run(supabase, userId, args) {
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const includeArchived = optionalBoolean(args, 'include_archived', false);
    const limit = optionalInt(args, 'limit', 25, 1, 100);

    const defs = await fetchDefinitionRows(supabase, userId);
    const aliasIndex = aliasIndexOf(defs);

    // Last-performed dates from lightweight name+date pairs (both log tables).
    const [setNames, cardioNames] = await Promise.all([
      fetchAllPages<NameDateRow>('workout_set_logs', (from, to) =>
        supabase
          .from('workout_set_logs')
          .select('exercise_name, event_date')
          .eq('user_id', userId)
          .eq('is_autofilled', false)
          .order('event_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllPages<NameDateRow>('workout_cardio_logs', (from, to) =>
        supabase
          .from('workout_cardio_logs')
          .select('exercise_name, event_date')
          .eq('user_id', userId)
          .eq('is_autofilled', false)
          .order('event_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);
    const lastPerformed = lastPerformedByCanonical([...setNames, ...cardioNames], aliasIndex.toCanonical);

    const matches = defs
      .filter(d => includeArchived || !d.archived_at)
      .filter(d => {
        if (!query) return true;
        if (d.canonical_name.toLowerCase().includes(query)) return true;
        return (d.aliases ?? []).some(a => a.toLowerCase().includes(query));
      })
      .slice(0, limit)
      .map(d => ({
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
      }));

    return { query: query || null, total_matches: matches.length, exercises: matches };
  },
};
