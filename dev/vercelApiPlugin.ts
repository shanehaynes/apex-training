import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';

// Serves the Vercel functions in api/ inside `vite dev`, so the full stack
// (writes, AI coach) runs from one process. Handlers are loaded through
// ssrLoadModule — free TS transform, and edits to api/ code apply on the
// next request without a server restart.
//
// SAFETY GATE: mounts only when VITE_SUPABASE_URL points at localhost (the
// local Supabase stack). There is deliberately no override — the service-role
// key bypasses RLS, and a dev server must never be able to aim it at the
// production project. Under plain `npm run dev` (offline mode) the plugin is
// inert and /api/* 404s, exactly as before.
//
// FIDELITY CAVEAT: this is not the Vercel runtime. JSON bodies, req.query,
// and the status/send/json/write/end response surface are emulated (all this
// app uses); anything Vercel-specific beyond that must be verified on a
// preview deploy.

interface VercelishRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body?: unknown;
  cookies: Record<string, string>;
}

interface VercelishResponse extends ServerResponse {
  status: (code: number) => VercelishResponse;
  json: (body: unknown) => VercelishResponse;
  send: (body: string | Buffer) => VercelishResponse;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function adaptRequest(req: IncomingMessage, rawBody: Buffer): VercelishRequest {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }

  const adapted = req as VercelishRequest;
  adapted.query = query;
  adapted.cookies = {};

  const contentType = req.headers['content-type'] ?? '';
  if (rawBody.length > 0 && contentType.includes('application/json')) {
    adapted.body = JSON.parse(rawBody.toString('utf8'));
  } else if (rawBody.length > 0) {
    adapted.body = rawBody.toString('utf8');
  }
  return adapted;
}

function adaptResponse(res: ServerResponse): VercelishResponse {
  const adapted = res as VercelishResponse;
  adapted.status = code => {
    adapted.statusCode = code;
    return adapted;
  };
  adapted.json = body => {
    if (!adapted.headersSent) adapted.setHeader('Content-Type', 'application/json; charset=utf-8');
    adapted.end(JSON.stringify(body));
    return adapted;
  };
  adapted.send = body => {
    if (!adapted.headersSent && !adapted.getHeader('content-type')) {
      adapted.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    adapted.end(body);
    return adapted;
  };
  return adapted;
}

export default function vercelApiPlugin(): Plugin {
  let enabled = false;

  return {
    name: 'apex:vercel-api',
    apply: 'serve',

    configResolved(config) {
      // Vite only exposes VITE_-prefixed vars to the client; the handlers
      // also need SUPABASE_SERVICE_ROLE_KEY etc. from the mode's env file,
      // so load everything into process.env (without clobbering the shell).
      const env = loadEnv(config.mode, config.root, '');
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }

      const supabaseUrl = process.env.VITE_SUPABASE_URL;
      let host: string | null = null;
      try {
        host = supabaseUrl ? new URL(supabaseUrl).hostname : null;
      } catch { /* malformed URL → stay disabled */ }

      enabled = host === '127.0.0.1' || host === 'localhost';
      if (enabled) {
        config.logger.info(`[apex:vercel-api] serving api/* against LOCAL Supabase (${supabaseUrl})`);
      } else if (supabaseUrl) {
        config.logger.warn(
          `[apex:vercel-api] api/* NOT mounted: VITE_SUPABASE_URL is not localhost (${supabaseUrl}). ` +
          'The service-role key must never be pointable at a remote project from a dev server.',
        );
      }
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        if (!enabled) {
          res.statusCode = 404;
          res.end('api/* is not served: dev API requires a local Supabase backend (npm run dev:agent)');
          return;
        }

        const name = req.url.slice('/api/'.length).split('?')[0].replace(/\/+$/, '');
        if (!/^[\w-]+$/.test(name)) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        try {
          const mod = await server.ssrLoadModule(`/api/${name}.ts`);
          const handler = mod.default as (req: VercelishRequest, res: VercelishResponse) => Promise<void>;
          if (typeof handler !== 'function') throw new Error(`api/${name}.ts has no default export`);

          const rawBody = await readBody(req);
          await handler(adaptRequest(req, rawBody), adaptResponse(res));
        } catch (err) {
          if ((err as { code?: string }).code === 'ERR_LOAD_URL' || /Failed to load url/.test(String(err))) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          server.config.logger.error(`[apex:vercel-api] ${name}: ${(err as Error).stack ?? err}`);
          if (!res.headersSent) res.statusCode = 500;
          res.end('Internal error');
        }
      });
    },
  };
}
