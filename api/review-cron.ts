import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAnthropicKey } from './_lib/anthropicKey.js';
import { sendReviewEmail } from './_lib/mailer.js';
import {
  createReview,
  deleteReview,
  fetchReviewInputs,
  getReview,
  listRecipients,
  markEmailSent,
  markEmailSkipped,
  saveCommentary,
  type Recipient,
} from './_lib/reviewData.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { renderReviewEmail } from '../src/lib/review/email.js';
import { getIsoMonth, lastCompletedIsoYear, lastCompletedMonth } from '../src/lib/review/isoMonth.js';
import {
  MONTHLY_MAX_TOKENS,
  MONTHLY_REVIEW_SYSTEM_PROMPT,
  REVIEW_MODEL,
  YEARLY_MAX_TOKENS,
  YEARLY_REVIEW_SYSTEM_PROMPT,
  buildMonthlyRecap,
  buildYearlyRecap,
} from '../src/lib/review/recap.js';
import { buildReviewPeriod, computeReviewStats, computeYearlyStats } from '../src/lib/review/stats.js';
import type { PeriodType, ReviewStats, YearlyStats } from '../src/lib/review/types.js';

// Daily review cron (vercel.json crons → 14:00 UTC). There is no boundary
// flag: every run computes the last completed 4-week training month (plus
// the last ISO year while we're inside month 1) and generates whatever has
// no `reviews` row yet — idempotent, and self-healing for missed runs. On
// non-boundary days the whole run is a handful of indexed lookups.
//
// Per user × period state machine, driven by the reviews row's columns:
//   no row                        → fetch logs, compute stats, insert row
//   email_skipped_reason set      → done (no activity, or no address)
//   ai_commentary null + user key → one-shot Anthropic call (per-user key;
//                                    users without a key go stats-only)
//   email_sent_at null            → render + send via Gmail SMTP, stamp sent
// Any failure leaves the row mid-state and tomorrow's run resumes from it.

export const maxDuration = 60;

// Timeout backstop: at most this many expensive items (compute/AI/send) per
// run; the rest resume tomorrow.
const MAX_WORK_ITEMS_PER_RUN = 10;

// After this many days of failing AI calls, send the email stats-only so a
// revoked key can't block a review forever.
const AI_RETRY_DAYS = 3;

interface WorkPeriod {
  periodType: PeriodType;
  isoYear: number;
  monthIndex?: number;
}

const periodName = (p: WorkPeriod) =>
  p.periodType === 'month' ? `${p.isoYear}-M${p.monthIndex}` : `${p.isoYear}`;

async function generateCommentary(
  apiKey: string,
  stats: ReviewStats | YearlyStats,
  displayName: string,
  periodType: PeriodType,
): Promise<string> {
  const yearly = periodType === 'year';
  const recap = yearly
    ? buildYearlyRecap(stats as YearlyStats, displayName)
    : buildMonthlyRecap(stats, displayName);
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: yearly ? YEARLY_MAX_TOKENS : MONTHLY_MAX_TOKENS,
    system: yearly ? YEARLY_REVIEW_SYSTEM_PROMPT : MONTHLY_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: recap }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Empty commentary response');
  return text;
}

function queryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Forced period from query params, or the schedule-derived defaults. */
function resolvePeriods(req: VercelRequest, now: Date): WorkPeriod[] | { badRequest: string } {
  const periodType = queryString(req, 'periodType');
  const isoYearRaw = queryString(req, 'isoYear');
  const monthIndexRaw = queryString(req, 'monthIndex');

  if (periodType !== undefined || isoYearRaw !== undefined || monthIndexRaw !== undefined) {
    if (periodType !== 'month' && periodType !== 'year') {
      return { badRequest: 'periodType must be "month" or "year"' };
    }
    const isoYear = Number(isoYearRaw);
    if (!Number.isInteger(isoYear)) return { badRequest: 'isoYear must be an integer' };
    if (periodType === 'month') {
      const monthIndex = Number(monthIndexRaw);
      if (!Number.isInteger(monthIndex) || monthIndex < 1 || monthIndex > 13) {
        return { badRequest: 'monthIndex must be 1-13' };
      }
      return [{ periodType, isoYear, monthIndex }];
    }
    if (monthIndexRaw !== undefined) return { badRequest: 'monthIndex is only valid for periodType=month' };
    return [{ periodType, isoYear }];
  }

  const month = lastCompletedMonth(now);
  const periods: WorkPeriod[] = [{ periodType: 'month', isoYear: month.isoYear, monthIndex: month.month }];
  // The year review only fires while inside month 1 of the new ISO year, so
  // a mid-year first deploy never emails a stale year-in-review.
  if (getIsoMonth(now).month === 1) {
    periods.push({ periodType: 'year', isoYear: lastCompletedIsoYear(now) });
  }
  return periods;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).send('Unauthorized');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const now = new Date();
  const resolved = resolvePeriods(req, now);
  if ('badRequest' in resolved) {
    res.status(400).send(resolved.badRequest);
    return;
  }
  const periods = resolved;
  const forcedUserId = queryString(req, 'userId');
  const dryRun = queryString(req, 'dryRun') === '1';
  // Regenerate: drop the stored row for one explicit user+period so it is
  // recomputed and re-sent (e.g. after a stats or formatting fix). Same
  // guardrails as a forced manual run — never fires on the scheduled sweep.
  const force = queryString(req, 'force') === '1';
  if (force && !dryRun) {
    if (!forcedUserId || periods.length !== 1) {
      res.status(400).send('force needs userId plus an explicit periodType/isoYear[/monthIndex]');
      return;
    }
    try {
      const [work] = periods;
      await deleteReview(supabase, forcedUserId, work.periodType, work.isoYear, work.monthIndex);
    } catch (err) {
      console.error('[api/review-cron] force delete failed:', err);
      res.status(500).send('Force delete failed');
      return;
    }
  }

  let recipients: Recipient[];
  try {
    recipients = await listRecipients(supabase);
  } catch (err) {
    console.error('[api/review-cron] recipient listing failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to list recipients');
    return;
  }
  if (forcedUserId) recipients = recipients.filter(r => r.userId === forcedUserId);

  // Dry run: compute and return, touch nothing — no row, no AI, no email.
  if (dryRun) {
    if (!forcedUserId || recipients.length === 0 || periods.length !== 1) {
      res.status(400).send('dryRun needs userId plus an explicit periodType/isoYear[/monthIndex]');
      return;
    }
    const [recipient] = recipients;
    const [work] = periods;
    try {
      const period = buildReviewPeriod(work.periodType, work.isoYear, work.monthIndex);
      const inputs = await fetchReviewInputs(supabase, recipient.userId, period);
      const stats = work.periodType === 'year' ? computeYearlyStats(inputs) : computeReviewStats(inputs);
      const recap =
        work.periodType === 'year'
          ? buildYearlyRecap(stats as YearlyStats, recipient.displayName)
          : buildMonthlyRecap(stats, recipient.displayName);
      const rendered = renderReviewEmail(stats, null, recipient.displayName);
      res.status(200).json({ stats, recap, subject: rendered.subject, wouldEmailTo: recipient.email });
    } catch (err) {
      console.error('[api/review-cron] dry run failed:', err);
      res.status(500).send('Dry run failed');
    }
    return;
  }

  const processed: Array<{ userId: string; period: string; action: string }> = [];
  const errors: Array<{ userId: string; period: string; error: string }> = [];
  let workBudget = MAX_WORK_ITEMS_PER_RUN;

  for (const recipient of recipients) {
    for (const work of periods) {
      const label = { userId: recipient.userId, period: periodName(work) };
      try {
        let row = await getReview(supabase, recipient.userId, work.periodType, work.isoYear, work.monthIndex);
        if (row && (row.email_sent_at || row.email_skipped_reason)) {
          processed.push({ ...label, action: 'already-done' });
          continue;
        }
        if (workBudget <= 0) {
          processed.push({ ...label, action: 'deferred' });
          continue;
        }
        workBudget -= 1;

        let stats: ReviewStats | YearlyStats;
        if (!row) {
          const period = buildReviewPeriod(work.periodType, work.isoYear, work.monthIndex);
          const inputs = await fetchReviewInputs(supabase, recipient.userId, period);
          stats = work.periodType === 'year' ? computeYearlyStats(inputs) : computeReviewStats(inputs);
          if (stats.totals.sessionsCompleted === 0) {
            await createReview(supabase, {
              userId: recipient.userId,
              periodType: work.periodType,
              isoYear: work.isoYear,
              monthIndex: work.monthIndex,
              stats,
              emailSkippedReason: 'no-activity',
            });
            processed.push({ ...label, action: 'skipped-no-activity' });
            continue;
          }
          row = await createReview(supabase, {
            userId: recipient.userId,
            periodType: work.periodType,
            isoYear: work.isoYear,
            monthIndex: work.monthIndex,
            stats,
          });
        } else {
          // Resume from the stored stats so a retried email matches the
          // original computation exactly.
          stats = row.stats as ReviewStats | YearlyStats;
        }

        let commentary = row.ai_commentary;
        if (!commentary) {
          const apiKey = await getAnthropicKey(supabase, recipient.userId);
          if (apiKey) {
            try {
              commentary = await generateCommentary(apiKey, stats, recipient.displayName, work.periodType);
              await saveCommentary(supabase, row.id, commentary);
            } catch (err) {
              const ageDays = (now.getTime() - new Date(row.created_at).getTime()) / 86_400_000;
              if (ageDays <= AI_RETRY_DAYS) {
                errors.push({ ...label, error: `AI commentary failed, will retry: ${err instanceof Error ? err.message : err}` });
                processed.push({ ...label, action: 'ai-retry' });
                continue;
              }
              commentary = null; // stats-only after AI_RETRY_DAYS of failures
            }
          }
        }

        if (!recipient.email) {
          await markEmailSkipped(supabase, row.id, 'no-email');
          processed.push({ ...label, action: 'skipped-no-email' });
          continue;
        }
        const rendered = renderReviewEmail(stats, commentary, recipient.displayName);
        await sendReviewEmail({ to: recipient.email, ...rendered });
        await markEmailSent(supabase, row.id);
        processed.push({ ...label, action: 'sent' });
      } catch (err) {
        console.error(`[api/review-cron] ${label.userId} ${label.period} failed:`, err);
        errors.push({ ...label, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  res.status(200).json({ processed, errors });
}
