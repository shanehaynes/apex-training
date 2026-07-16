import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { getAnthropicKey } from './_lib/anthropicKey.js';
import { athleteSection } from '../src/lib/coach/prompt.js';

// One-shot post-workout coach summary, running on the caller's own
// Anthropic key (server-only user_api_keys table). PRs arrive pre-computed
// inside the recap (see src/lib/tracking/records.ts) — the model narrates
// them, it never queries or derives them, keeping token spend to a single
// small completion.

const SYSTEM_PROMPT =
  "You are the user's personal training coach reviewing a workout they just finished. " +
  'Write a brief, punchy summary: 2-4 sentences. Acknowledge the work, call out any ' +
  'personal records listed in the recap (they are pre-computed and verified — never ' +
  'invent records that are not listed), and make one pointed observation, e.g. skipped ' +
  'sets, a big jump versus last time, or a strong finish. Speak directly to the user in ' +
  'second person. Plain prose only: no greeting, no sign-off, no markdown, no bullet points.';

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

  let apiKey: string | null;
  try {
    apiKey = await getAnthropicKey(supabase, userId);
  } catch (err) {
    console.error('[api/coach-summary] key lookup failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to load API key');
    return;
  }
  if (!apiKey) {
    // The summary popup degrades gracefully on this — no toast, no retry.
    res.status(402).send('anthropic-key-missing');
    return;
  }

  const body = req.body as { recap?: unknown } | undefined;
  if (typeof body?.recap !== 'string' || !body.recap.trim()) {
    res.status(400).send('Missing recap');
    return;
  }

  // Personalization is best-effort: a failed profile read degrades to the
  // generic prompt rather than failing the summary.
  let athlete = '';
  try {
    const { data } = await supabase
      .from('profiles')
      .select('coach_goal, coach_context')
      .eq('id', userId)
      .maybeSingle();
    athlete = athleteSection(data?.coach_goal, data?.coach_context);
  } catch (err) {
    console.error('[api/coach-summary] profile read failed:', err instanceof Error ? err.message : err);
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      system: SYSTEM_PROMPT + athlete,
      messages: [{ role: 'user', content: body.recap }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!text) {
      res.status(502).send('Empty summary response');
      return;
    }
    res.status(200).json({ text });
  } catch (err) {
    console.error('[api/coach-summary] generation failed:', err);
    res.status(500).send('Summary generation failed');
  }
}
