import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { detachInstance, rescheduleInstance, skipInstance } from '../services/eventInstances.js';
import { sendFailure } from '../services/result.js';

// HTTP door onto api/_lib/services/eventInstances.ts (skip / reschedule /
// detach one occurrence of a recurring series). Auth, throttles and body
// parsing here; the mutations are shared with the coach's executors (W5b).

interface InstanceBody {
  eventId?: string;
  date?: string;
  eventTitle?: string;
  /** Audit-log attribution; omitted → the DB default ('ai'). */
  triggeredBy?: 'user' | 'ai';
  /** When present, reschedules the occurrence instead of skipping it. */
  overrides?: { date?: string; startTime?: string; endTime?: string };
  /** 'detach': materialize the occurrence as the standalone event in `event`. */
  action?: 'detach';
  /** The detached occurrence's new standalone row (snake_case, allowlisted). */
  event?: Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  const body = req.body as InstanceBody | undefined;
  if (!body?.eventId || !body.date) {
    res.status(400).send('Missing eventId or date');
    return;
  }

  const triggeredBy = body.triggeredBy === 'user' || body.triggeredBy === 'ai' ? body.triggeredBy : undefined;
  if (triggeredBy !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

  const target = { eventId: body.eventId, date: body.date, eventTitle: body.eventTitle, triggeredBy };

  if (body.action === 'detach') {
    const result = await detachInstance(supabase, userId, target, body.event ?? {});
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json(result.value);
    return;
  }

  if (body.overrides) {
    const result = await rescheduleInstance(supabase, userId, target, body.overrides);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  const result = await skipInstance(supabase, userId, target);
  if (!result.ok) return sendFailure(res, result);
  res.status(200).json({ ok: true });
}
