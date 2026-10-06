import type { McpToolDef } from './protocol.js';
import { MCP_TOOLS } from './toolRegistry.js';
import { ACCOUNT_READ_TOOLS } from './tools/account.js';
import { MCP_WRITE_TOOLS } from './writeTools.js';

// What /api/mcp serves. Three lists, because three callers need different
// cuts of one surface:
//
//   MCP_TOOLS (toolRegistry.ts)  the ten query tools — ALSO the in-app
//                                coach's read surface and /api/query's menu,
//                                which is why this module and not that one
//                                imports the write tools: api/chat.ts reaches
//                                toolRegistry, and must not pull the coach
//                                executor graph into the streaming lambda.
//   MCP_CONNECTOR_READ_TOOLS     those plus the connector-only reads: what a
//                                read-only token is shown.
//   MCP_CONNECTOR_TOOLS          everything, reads first: what the handler
//                                dispatches over for every token, so that a
//                                read-only token calling a write tool gets
//                                the dispatcher's read-only refusal (which
//                                says how to get write access) rather than
//                                "unknown tool".

export const MCP_CONNECTOR_READ_TOOLS: readonly McpToolDef[] = [...MCP_TOOLS, ...ACCOUNT_READ_TOOLS];

export { MCP_WRITE_TOOLS };

export const MCP_CONNECTOR_TOOLS: readonly McpToolDef[] = [...MCP_CONNECTOR_READ_TOOLS, ...MCP_WRITE_TOOLS];
