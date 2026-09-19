import type { VercelRequest, VercelResponse } from '@vercel/node';
import { optionalEnv } from '../env.js';
import { healthFlags } from '../health.js';

// Which build is serving, and whether it is configured: `sha` is the commit
// Vercel stamped on the deployment, or "dev" when nothing did (local dev,
// tests, a non-Vercel host), alongside the health booleans from health.ts
// (`publicOrigin`, `keyEncryption`) — booleans only, never values.
//
// This is also the endpoint an external uptime monitor polls, so it stays
// cheap: no database, no network, no await.
//
// Deliberately unauthenticated: the repo is public, so the SHA of main leaks
// nothing, and scripts/deploy-verify.sh must read it with no credentials.
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  res.status(200).json({
    sha: optionalEnv('VERCEL_GIT_COMMIT_SHA') ?? 'dev',
    ...healthFlags(),
  });
}
