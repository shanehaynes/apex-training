import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalResource, OAUTH_SCOPE, publicOrigin } from '../oauth/common.js';

// OAuth discovery documents for the MCP connector flow. Served from
// /api/oauth-metadata and surfaced at the spec-required well-known paths via
// vercel.json rewrites (?kind=resource → RFC 9728 protected-resource
// metadata; ?kind=server → RFC 8414 authorization-server metadata). Public
// and unauthenticated by design.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  const origin = publicOrigin(req);
  const kind = req.query.kind;

  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (kind === 'resource') {
    res.status(200).json({
      resource: canonicalResource(origin),
      authorization_servers: [origin],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
    });
    return;
  }

  if (kind === 'server') {
    res.status(200).json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth-authorize`,
      token_endpoint: `${origin}/api/oauth-token`,
      registration_endpoint: `${origin}/api/oauth-register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPE],
    });
    return;
  }

  res.status(404).send('Unknown metadata document');
}
