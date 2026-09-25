import type { McpToolDef } from './protocol.js';
import { getScheduleTool, getWorkoutDetailTool } from './tools/schedule.js';
import { getExerciseHistoryTool, getPeriodStatsTool, getPrsTool } from './tools/tracking.js';
import { getTrainingBlocksTool } from './tools/blocks.js';
import { searchExercisesTool } from './tools/library.js';
import { getMealsTool } from './tools/meals.js';
import { getSessionSummariesTool } from './tools/sessions.js';
import { getReviewsTool } from './tools/reviews.js';

// The MCP tool surface — read-only by design. MCP clients are an
// untrusted-input channel (anything the connected model reads can try to
// steer it), so v1 exposes queries only; mutations stay behind the in-app
// coach's confirmation flow.
//
// search_history (tools/history.ts) is deliberately NOT here: it reads
// coach_messages, the athlete's private conversations with the coach, which
// is service-role only and never leaves the app. Only the in-app coach
// (api/_lib/coach/readTools.ts) may call it.

export const MCP_TOOLS: readonly McpToolDef[] = [
  getScheduleTool,
  getWorkoutDetailTool,
  getExerciseHistoryTool,
  getPrsTool,
  getPeriodStatsTool,
  getTrainingBlocksTool,
  searchExercisesTool,
  getMealsTool,
  getSessionSummariesTool,
  getReviewsTool,
];
