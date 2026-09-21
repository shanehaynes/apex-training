import { healthFlags } from '../health.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { optionalEnv } from '../env.js';
import { minBuild, updateMessage } from '../clientVersion.js';

// Which build is serving, and which builds it still serves:
//   { sha, minBuild, message?, publicOrigin, keyEncryption }
// `sha` is the commit Vercel stamped on the deployment, or "dev" when nothing
// did (local dev, tests, a non-Vercel host). `minBuild` is the oldest iOS
// CFBundleVersion the deployment accepts — 0 gates nothing — and `message` is
// what the app's update screen says when the deployment sets one.
// Both come from clientVersion.ts; the app fetches this at launch. The two
// booleans are health.ts's configuration flags, for scripts/deploy-verify.sh.
//
// Deliberately unauthenticated: the repo is public, so the SHA of main leaks
// nothing, scripts/deploy-verify.sh must read it with no credentials, and the
// update gate has to answer a signed-out launch too.
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  const message = updateMessage();
  res.status(200).json({
    sha: optionalEnv('VERCEL_GIT_COMMIT_SHA') ?? 'dev',
    minBuild: minBuild(),
    ...(message ? { message } : {}),
    ...healthFlags(),
  });
}
