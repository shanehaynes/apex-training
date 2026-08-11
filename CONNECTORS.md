# Connecting AI Assistants to Apex Training

Apex Training ships a remote [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) server at `https://<your-deployment>/api/mcp`, so AI
assistants — Claude Desktop, claude.ai, Claude Code, ChatGPT — can query your
training data directly in conversation: *"How did my squat progress this
block?"*, *"What's on my calendar this week?"*, *"Any PRs last month?"*

Everything the server exposes is **read-only**. An assistant can never create,
edit, or delete anything through this connection — mutations remain exclusive
to the in-app coach, behind its per-action confirmation flow.

For the deployment at `apextrainingcalendar.vercel.app`, the server URL is:

```
https://apextrainingcalendar.vercel.app/api/mcp
```

---

## Claude Desktop / claude.ai (OAuth — recommended)

1. Open **Settings → Connectors** (on Team/Enterprise plans an Owner adds it
   under **Organization settings → Connectors** first).
2. Click **Add custom connector**, paste the server URL above, and **leave the
   OAuth Client ID / Client Secret fields blank** — Claude discovers Apex's
   authorization server automatically and registers itself.
3. Click **Connect**. Your browser lands on Apex's consent page: sign in with
   your Apex account (if you aren't already) and click **Allow**.
4. In any chat, open the **+** menu → **Connectors** and enable Apex for that
   conversation.

Access is granted per Apex account: whoever completes the sign-in is the user
whose data the assistant sees. Tokens expire hourly and refresh automatically.

## Claude Code (personal access token)

Mint a token in the Apex app under **Profile → AI connector** (it is shown
exactly once — copy it immediately), then:

```bash
claude mcp add --transport http apex https://apextrainingcalendar.vercel.app/api/mcp \
  --header "Authorization: Bearer apx_..."
```

Claude Code also supports the OAuth flow (`claude mcp add --transport http
apex <url>` with no header, then `/mcp` to authenticate), if you'd rather not
manage a token.

## ChatGPT (developer mode)

Custom MCP connectors in ChatGPT require a paid plan (Plus, Pro, Business,
Enterprise, or Edu) and developer mode:

1. **Settings → Apps & Connectors → Advanced settings** → enable
   **Developer mode**. (On Business/Enterprise a workspace admin can have this
   disabled org-wide.)
2. **Settings → Apps & Connectors → Create**: name it Apex, paste the server
   URL, choose **OAuth** authentication, and leave client fields blank —
   ChatGPT registers itself the same way Claude does and sends you to Apex's
   consent page. Sign in and click **Allow**.
3. In a chat, enable the Apex connector from the composer's **+ / Tools**
   menu, then ask away.

Because every tool is read-only, ChatGPT's write-action confirmation prompts
never appear.

> **Deep research:** ChatGPT's deep-research connectors specifically require
> tools named `search` and `fetch`, which Apex does not expose. Apex works as
> a regular chat connector, not a deep-research source.

## Other MCP clients

Any client that speaks Streamable HTTP works. Two common shapes:

- **OAuth-capable clients** need no configuration beyond the URL — discovery
  starts from the standard `/.well-known/oauth-protected-resource` document.
- **Header-capable clients** can send a personal access token as
  `Authorization: Bearer apx_...`. For clients that support neither (stdio
  only), bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

  ```bash
  npx mcp-remote https://apextrainingcalendar.vercel.app/api/mcp \
    --header "Authorization: Bearer apx_..."
  ```

---

## What the assistant can query

| Tool | Answers questions like |
|---|---|
| `get_schedule` | "What's planned this week?" — occurrences in a date range with completion flags |
| `get_workout_detail` | "How did Tuesday's session go?" — full prescription + logged sets/cardio, each set annotated with estimated 1RM |
| `get_exercise_history` | "Is my bench progressing?" — all-time best, per-session trend, recent sessions (alias-aware naming) |
| `get_prs` | "Any records lately?" — all-time bests, or records set within a period with what they beat |
| `get_period_stats` | "Summarize July" — sessions by type, tonnage, cardio distance/elevation, streaks, PRs (13-month ISO training calendar) |
| `get_training_blocks` | "Am I on target this block?" — blocks, objectives, weekly-target attainment |
| `search_exercises` | "What do you call the cable row?" — library search across names and aliases |
| `get_meals` | "How was my protein this week?" — meals with per-day macro totals |

All numbers (estimated 1RM via Epley, tonnage, streaks, attainment) are
computed server-side by the same code the app itself uses — the assistant
cites them rather than deriving its own.

## Managing access

Everything lives in the Apex app under **Profile → AI connector**:

- **Connected apps** (OAuth): each connected client is listed with a
  disconnect button, which revokes every token that client holds.
- **Personal access tokens**: named, shown once at creation, revocable
  individually. The server stores only a hash.
- Claude's connector UI additionally lets you block individual tools per
  connector, and asks before the first use of each tool in a conversation.

Rate limiting: 300 MCP requests per hour per user.

## Troubleshooting

- **"Couldn't register" / sign-in never starts** — check discovery is alive:
  `curl https://<deployment>/.well-known/oauth-protected-resource` must return
  JSON, not HTML. If it returns HTML, the SPA rewrite is shadowing the
  discovery rewrites in `vercel.json` (order matters — first match wins).
- **401 from `/api/mcp`** — the token is missing, revoked, expired, or a
  Supabase session JWT was pasted where an `apx_` token belongs. The 401's
  `WWW-Authenticate` header carries the discovery URL OAuth clients need.
- **Assistant sees stale data** — there is no cache on the server side; the
  assistant may be reusing an earlier tool result in its context. Ask it to
  re-query.

## For developers

Server code lives in [`api/_lib/mcp/`](api/_lib/mcp) (protocol, tools) and
[`api/_lib/handlers/`](api/_lib/handlers) (`mcp.ts`, `mcpTokens.ts`,
`oauth*.ts`), with the OAuth 2.1 pieces in [`api/_lib/oauth/`](api/_lib/oauth).
It is a stateless Streamable HTTP server (2025-06-18 MCP revision): POST
JSON-RPC in, JSON out, no SSE, no session ids. Auth is a bearer token —
either a personal access token or an OAuth access token minted by the built-in
authorization server (RFC 7591 dynamic client registration, PKCE S256,
RFC 9728/8414 discovery, rotating refresh tokens). Tables: `mcp_tokens`
(phase 26), `oauth_clients` / `oauth_codes` (phase 28).
