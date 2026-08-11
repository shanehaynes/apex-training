import { Hono, type Context } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import events from './handlers/events.js';
import workoutSessions from './handlers/workoutSessions.js';
import profile from './handlers/profile.js';
import exerciseDefinitions from './handlers/exerciseDefinitions.js';
import templateCopy from './handlers/templateCopy.js';
import eventInstances from './handlers/eventInstances.js';
import coachSummary from './handlers/coachSummary.js';
import mutationsLog from './handlers/mutationsLog.js';
import completions from './handlers/completions.js';
import mcp from './handlers/mcp.js';
import mcpTokens from './handlers/mcpTokens.js';
import oauthMetadata from './handlers/oauthMetadata.js';
import oauthRegister from './handlers/oauthRegister.js';
import oauthAuthorize from './handlers/oauthAuthorize.js';
import oauthApprove from './handlers/oauthApprove.js';
import oauthToken from './handlers/oauthToken.js';
import providerSync from './handlers/providerSync.js';
import providerCallback from './handlers/providerCallback.js';
import providerCron from './handlers/providerCron.js';
import { handleTrainingBlocks } from './trainingBlocks.js';
import { handleMeals } from './meals.js';
import { handleMealFavorites } from './mealFavorites.js';

// All consolidated /api/* routes live here, served by the single catch-all
// function api/[...path].ts — the Vercel Hobby plan caps a deployment at 12
// serverless functions, so per-endpoint api/*.ts files don't scale. Only
// chat (streaming, heavy imports), review-cron (cron target), and
// calendar-feed (public token auth) remain standalone functions.
//
// Handlers keep their Vercel (req, res) signatures; Hono only routes. Each
// bridge writes the response through the raw Node objects and returns the
// RESPONSE_ALREADY_SENT sentinel so Hono doesn't produce a second response.

type NodeHandler = (req: VercelRequest, res: VercelResponse) => void | Promise<void>;
type Env = { Bindings: { incoming: VercelRequest; outgoing: VercelResponse } };

const bridge =
  (h: NodeHandler, patch?: (req: VercelRequest) => void) => async (c: Context<Env>) => {
    if (patch) patch(c.env.incoming);
    await h(c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  };

export const app = new Hono<Env>().basePath('/api');
app.all('/events', bridge(events));
// handleTrainingBlocks dispatches on query.resource internally (its original
// contract as an events.ts delegate); the clean paths inject it.
app.all('/blocks', bridge(handleTrainingBlocks, r => { r.query.resource = 'block'; }));
app.all('/objectives', bridge(handleTrainingBlocks, r => { r.query.resource = 'objective'; }));
app.all('/meals', bridge(handleMeals));
app.all('/meal-favorites', bridge(handleMealFavorites));
app.all('/workout-sessions', bridge(workoutSessions));
app.all('/profile', bridge(profile));
app.all('/exercise-definitions', bridge(exerciseDefinitions));
app.all('/template-copy', bridge(templateCopy));
app.all('/event-instances', bridge(eventInstances));
app.all('/coach-summary', bridge(coachSummary));
app.all('/mutations-log', bridge(mutationsLog));
app.all('/completions', bridge(completions));
// Remote MCP server (bearer PAT auth, not Supabase JWT) + its token CRUD.
app.all('/mcp', bridge(mcp));
app.all('/mcp-tokens', bridge(mcpTokens));
// OAuth 2.1 server for MCP connectors. Single-segment route names on
// purpose — dev/vercelApiPlugin.ts rejects nested /api/* paths. The
// /.well-known/* discovery paths rewrite to oauth-metadata (vercel.json in
// prod, the dev plugin locally); only oauth-approve carries a Supabase JWT.
app.all('/oauth-metadata', bridge(oauthMetadata));
app.all('/oauth-register', bridge(oauthRegister));
app.all('/oauth-authorize', bridge(oauthAuthorize));
app.all('/oauth-approve', bridge(oauthApprove));
app.all('/oauth-token', bridge(oauthToken));
// Fitness-provider sync (COROS): connection + activity grab, and the OAuth
// redirect target (browser navigation, state-token auth — no Supabase JWT).
app.all('/provider-sync', bridge(providerSync));
app.all('/provider-callback', bridge(providerCallback));
// Nightly auto-sync cron target (CRON_SECRET bearer, vercel.json schedule).
app.all('/provider-cron', bridge(providerCron));
// Distinctive message: if /api/chat (or another standalone route) ever lands
// here, filesystem precedence over the catch-all broke — see the plan's
// preview-deploy curl matrix.
app.notFound(c => c.text(`No API route: ${new URL(c.req.url).pathname}`, 404));

// OAuth discovery paths. The vercel.json rewrites route /.well-known/* into
// this function, but Vercel hands the function the ORIGINAL req.url — the
// rewrite destination only selects the function — so the router would 404 on
// the /api basePath. Normalize here (the dev plugin does the same for vite).
const WELL_KNOWN: Array<[prefix: string, kind: string]> = [
  ['/.well-known/oauth-protected-resource', 'resource'],
  ['/.well-known/oauth-authorization-server', 'server'],
];

function normalizeWellKnown(req: VercelRequest): void {
  for (const [prefix, kind] of WELL_KNOWN) {
    if (req.url?.startsWith(prefix)) {
      req.url = `/api/oauth-metadata?kind=${kind}`;
      // The metadata handler reads req.query.kind; stamp it rather than
      // trusting Vercel to have merged the rewrite destination's query.
      req.query = { ...req.query, kind };
      return;
    }
  }
}

// Node (req, res) entrypoint — the same callable shape Vercel invokes in
// prod, dev/vercelApiPlugin.ts invokes in dev, and tests invoke directly.
// (@hono/node-server v2 dropped its /vercel adapter; this is the same thing:
// route via app.fetch, but let handlers write to the real res. Only the
// router's own responses — the 404 — come back as a fetch Response.)
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  normalizeWellKnown(req);
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const response = await app.fetch(new Request(url, { method: req.method }), {
    incoming: req,
    outgoing: res,
  });
  if (response !== RESPONSE_ALREADY_SENT) {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  }
}
