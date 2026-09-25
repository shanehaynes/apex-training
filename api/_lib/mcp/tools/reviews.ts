import type { McpToolDef } from '../protocol.js';
import { optionalEnum, optionalInt } from '../args.js';
import type { ReviewRow } from '../../../../src/lib/db/types.js';
import type { PeriodType } from '../../../../src/lib/review/types.js';
import { buildReviewPeriod } from '../../../../src/lib/review/stats.js';

// Stored monthly / yearly reviews: the pre-computed stats the review cron
// wrote (reviews.stats, every number computed by src/lib/review/stats.ts)
// and the commentary the model narrated over them (reviews.ai_commentary).
// Nothing is recomputed here — get_period_stats is the tool for a period
// that has no stored review yet.

const MAX_LIMIT = 12;
const KINDS = ['month', 'year'] as const;

export const getReviewsTool: McpToolDef = {
  name: 'get_reviews',
  description:
    'Stored monthly and yearly reviews, newest first: the period label, the coach\'s written commentary ' +
    '(null when none was generated) and the pre-computed stats behind it. Filter with kind. ' +
    'Months are the 13-month ISO training calendar.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...KINDS], description: 'Only this period type. Default: both.' },
      limit: { type: 'integer', description: 'Reviews to return (default 6, max 12).' },
    },
  },
  async run(supabase, userId, args) {
    const kind = args.kind === undefined || args.kind === null
      ? undefined
      : optionalEnum<PeriodType>(args, 'kind', KINDS, 'month');
    const limit = optionalInt(args, 'limit', 6, 1, MAX_LIMIT);

    let query = supabase.from('reviews').select('*').eq('user_id', userId);
    if (kind) query = query.eq('period_type', kind);
    // Enough rows to rank across both kinds in JS below; the period start is
    // the honest "newest" — a year row and its month rows share an iso_year.
    const { data, error } = await query
      .order('iso_year', { ascending: false })
      .order('month_index', { ascending: false, nullsFirst: true })
      .limit(kind ? limit : limit * 2);
    if (error) throw new Error(`reviews fetch failed: ${error.message}`);

    const reviews = ((data ?? []) as ReviewRow[])
      .flatMap(row => {
        if (row.period_type === 'month' && row.month_index == null) return [];
        if (row.period_type !== 'month' && row.period_type !== 'year') return [];
        const period = buildReviewPeriod(row.period_type, row.iso_year, row.month_index ?? undefined);
        return [{ row, period }];
      })
      .sort((a, b) => b.period.startDate.localeCompare(a.period.startDate) || a.row.period_type.localeCompare(b.row.period_type))
      .slice(0, limit)
      .map(({ row, period }) => ({
        kind: row.period_type,
        periodLabel: period.label,
        startDate: period.startDate,
        endDateExclusive: period.endDateExclusive,
        commentary: row.ai_commentary,
        stats: row.stats,
      }));

    return { reviews };
  },
};
