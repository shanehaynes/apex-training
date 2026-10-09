import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { apnsConfig, sendApns, type ApnsConfig, type ApnsEnvironment, type ApnsTransport } from '../apns.js';
import { fail, succeed, type ServiceResult } from './result.js';

// Ending the iOS tracker's Live Activity by push (W12 follow-up, phase52).
//
// The phone ends its own card when the workout finishes on the phone, and
// after a schedule refresh when it finished anywhere else — but a refresh
// needs the app running, and the card matters most on a locked phone. So the
// app registers each activity's APNs token here, and every server path that
// ends a session (a finish or cancel from either tracker, a completion from
// the calendar or the coach, a quick-complete, a provider import) calls
// `endLiveActivities`, which sends ActivityKit an `end` and forgets the token.
//
// Best-effort by construction: no APNs key configured is a silent no-op, and
// a failed read or send is logged, never thrown. Nothing a push does may fail
// the write that triggered it; the app-side end is still there behind it.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** `<bundle id>.push-type.liveactivity`, ActivityKit's topic for the app. */
export const LIVE_ACTIVITY_TOPIC = 'com.shanehaynes.apextraining.push-type.liveactivity';

/** Seconds from the Unix epoch to 2001-01-01, Foundation's reference date. */
const REFERENCE_DATE_OFFSET_S = 978_307_200;

/** Tokens past this are of no use: an activity lives 8 h, then lingers ≤ 4 h. */
const TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_PATTERN = /^[0-9a-f]{16,400}$/;

export interface SessionKey {
  eventId: string;
  eventDate: string;
}

/**
 * The `end` event's body. `content-state` is decoded on the phone into
 * `TrackerActivityAttributes.ContentState` with a default `JSONDecoder`, so
 * its shape is Swift's synthesized Codable: dates as seconds since 2001 (not
 * 1970), and `Phase.done(totalSeconds:)` as `{"done":{"totalSeconds":n}}`.
 * `ios/Fixtures/live-activity-end.json` pins it from both sides —
 * api/__tests__/live-activity.test.ts writes it, ApexTests decodes it.
 * `dismissal-date` = now takes the card off the Lock Screen at once.
 */
export function endPayload(startedAt: Date, totalSeconds: number, nowMs: number) {
  const now = Math.floor(nowMs / 1000);
  return {
    aps: {
      timestamp: now,
      event: 'end',
      'dismissal-date': now,
      'content-state': {
        startedAt: startedAt.getTime() / 1000 - REFERENCE_DATE_OFFSET_S,
        phase: { done: { totalSeconds } },
      },
    },
  };
}

export interface RegisterBody {
  eventId?: unknown;
  eventDate?: unknown;
  token?: unknown;
  environment?: unknown;
  startedAt?: unknown;
}

/** Store one activity's push token, replacing whatever held it before. */
export async function registerLiveActivityToken(
  supabase: Admin,
  userId: string,
  body: RegisterBody,
  nowMs: number = Date.now(),
): Promise<ServiceResult> {
  const { eventId, eventDate, environment, startedAt } = body;
  const token = typeof body.token === 'string' ? body.token.toLowerCase() : body.token;
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 200) {
    return fail(400, 'eventId must be a non-empty string');
  }
  if (typeof eventDate !== 'string' || !DATE_PATTERN.test(eventDate)) {
    return fail(400, 'eventDate must be YYYY-MM-DD');
  }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return fail(400, 'token must be a hex APNs token');
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    return fail(400, "environment must be 'sandbox' or 'production'");
  }
  const started = typeof startedAt === 'string' ? new Date(startedAt) : null;
  if (!started || Number.isNaN(started.getTime())) {
    return fail(400, 'startedAt must be an ISO timestamp');
  }

  const { error } = await supabase.from('live_activity_tokens').upsert(
    {
      user_id: userId,
      event_id: eventId,
      event_date: eventDate,
      push_token: token,
      environment,
      started_at: started.toISOString(),
      created_at: new Date(nowMs).toISOString(),
    },
    { onConflict: 'push_token' },
  );
  if (error) {
    console.error('[live-activity] register failed:', error.message);
    return fail(500, 'Failed to register the token');
  }
  // Tokens are never history; sweep this user's dead ones on the way out.
  const cutoff = new Date(nowMs - TOKEN_RETENTION_MS).toISOString();
  const { error: sweepErr } = await supabase
    .from('live_activity_tokens').delete().eq('user_id', userId).lt('created_at', cutoff);
  if (sweepErr) console.error('[live-activity] sweep failed:', sweepErr.message);
  return succeed(undefined);
}

/** The app ended the activity itself: its tokens have nothing left to end. */
export async function forgetLiveActivityTokens(
  supabase: Admin,
  userId: string,
  session: { eventId?: unknown; eventDate?: unknown },
): Promise<ServiceResult> {
  if (typeof session.eventId !== 'string' || session.eventId.length === 0) return fail(400, 'eventId is required');
  if (typeof session.eventDate !== 'string' || !DATE_PATTERN.test(session.eventDate)) {
    return fail(400, 'eventDate must be YYYY-MM-DD');
  }
  const { error } = await supabase.from('live_activity_tokens').delete()
    .eq('user_id', userId).eq('event_id', session.eventId).eq('event_date', session.eventDate);
  if (error) {
    console.error('[live-activity] forget failed:', error.message);
    return fail(500, 'Failed to forget the tokens');
  }
  return succeed(undefined);
}

/** 200, or a 4xx other than 429: nothing a retry of the same token would change. */
function isFinal(status: number): boolean {
  return status === 200 || (status >= 400 && status < 500 && status !== 429);
}

export interface EndDeps {
  /** Defaults to the env-configured key; null means "not configured". */
  config?: ApnsConfig | null;
  transport?: ApnsTransport;
  nowMs?: number;
}

/**
 * Push `end` to every activity registered for this session, then drop the
 * tokens. `totalSeconds` is the finished session's own total when the caller
 * has it; otherwise the elapsed time since the activity's start. Returns how
 * many pushes APNs accepted. Never throws.
 */
export async function endLiveActivities(
  supabase: Admin,
  userId: string,
  session: SessionKey,
  options: { totalSeconds?: number } = {},
  deps: EndDeps = {},
): Promise<number> {
  try {
    const config = deps.config === undefined ? apnsConfig() : deps.config;
    if (!config) return 0;
    const nowMs = deps.nowMs ?? Date.now();

    const { data, error } = await supabase
      .from('live_activity_tokens')
      .select('id, push_token, environment, started_at')
      .eq('user_id', userId)
      .eq('event_id', session.eventId)
      .eq('event_date', session.eventDate);
    if (error) {
      console.error('[live-activity] token read failed:', error.message);
      return 0;
    }
    const rows = data ?? [];
    if (rows.length === 0) return 0;

    const results = await Promise.all(rows.map(async row => {
      const startedAt = new Date(row.started_at);
      const totalSeconds = options.totalSeconds
        ?? Math.max(0, Math.round((nowMs - startedAt.getTime()) / 1000));
      const send = (environment: ApnsEnvironment) => sendApns(config, {
        token: row.push_token,
        environment,
        topic: LIVE_ACTIVITY_TOPIC,
        pushType: 'liveactivity',
        priority: 10,
        payload: endPayload(startedAt, totalSeconds, nowMs),
      }, deps.transport, nowMs);
      const environment = row.environment as ApnsEnvironment;
      const first = await send(environment);
      // The app's environment is a build-time guess (DEBUG → sandbox). A
      // token sent to the wrong host comes back BadDeviceToken; the other
      // host is the only other place it can belong.
      if (first.status === 400 && first.reason === 'BadDeviceToken') {
        return send(environment === 'sandbox' ? 'production' : 'sandbox');
      }
      return first;
    }));
    results.forEach(r => {
      if (r.status !== 200) console.error(`[live-activity] end push failed: ${r.status} ${r.reason ?? ''}`.trim());
    });

    // Accepted or refused for good, a token is done with: an ended activity
    // takes no more pushes, and an expired or unknown one never will. A
    // timeout, 429 or 5xx is APNs' problem, not the token's — keep it, so the
    // next end path for this session (a web finish is followed by its
    // completion write; the phone replays its queue) gets another try. The
    // day-old sweep on register is the backstop.
    const done = rows.filter((_, i) => isFinal(results[i].status)).map(r => r.id);
    if (done.length > 0) {
      const { error: deleteErr } = await supabase.from('live_activity_tokens').delete().in('id', done);
      if (deleteErr) console.error('[live-activity] token delete failed:', deleteErr.message);
    }
    return results.filter(r => r.status === 200).length;
  } catch (err) {
    console.error('[live-activity] end failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
