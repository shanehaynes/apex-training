import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// One-shot post-workout coach summary. PRs arrive pre-computed inside the
// recap (see src/lib/tracking/records.ts) — the model narrates them, it
// never queries or derives them, keeping token spend to a single small
// completion. Server-side so the Anthropic key stays out of the browser.

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

  // VITE_ fallback: the pre-proxy deployments configured the key under the
  // VITE_ name. Server-side it is a plain env var — safe as long as no
  // client code references it via import.meta.env (none does).
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).send('ANTHROPIC_API_KEY not configured');
    return;
  }

  const body = req.body as { recap?: unknown } | undefined;
  if (typeof body?.recap !== 'string' || !body.recap.trim()) {
    res.status(400).send('Missing recap');
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
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
