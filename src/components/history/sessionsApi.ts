import { postJson } from '../../lib/api';

// The web's door onto the list_sessions MCP tool: POST /api/query runs the
// same McpToolDef.run the connector and iOS use, so the history the overlay
// shows is the history the coach reads.

export interface SessionListRow {
  id: string;
  eventId: string;
  eventDate: string;
  title: string;
  type: string | null;
  sport: string | null;
  tags: string[];
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  hasSummary: boolean;
  score: { type: string; timeSeconds: number | null; rounds: number | null; reps: number | null } | null;
}

export interface SessionListPage {
  sessions: SessionListRow[];
  nextCursor: string | null;
}

export interface SessionListQuery {
  cursor?: string;
  limit?: number;
  type?: string;
  sport?: string;
  exercise?: string;
  tag?: string;
  q?: string;
}

export async function listSessions(query: SessionListQuery): Promise<SessionListPage> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') args[k] = v;
  const data = await postJson<{ result?: Partial<SessionListPage> }>(
    '/api/query',
    { tool: 'list_sessions', args },
    'Loading history',
  );
  const sessions = Array.isArray(data?.result?.sessions) ? data.result!.sessions : [];
  const nextCursor = typeof data?.result?.nextCursor === 'string' ? data.result.nextCursor : null;
  return { sessions, nextCursor };
}
