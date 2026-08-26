import type { VercelRequest, VercelResponse } from '@vercel/node';
import { optionalEnv } from '../env.js';

// Which build is serving: the commit SHA Vercel stamped on the deployment,
// or "dev" when nothing did (local dev, tests, a non-Vercel host).
// Deliberately unauthenticated: the repo is public, so the SHA of main leaks
// nothing, and scripts/deploy-verify.sh must read it with no credentials.
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  res.status(200).json({ sha: optionalEnv('VERCEL_GIT_COMMIT_SHA') ?? 'dev' });
}
