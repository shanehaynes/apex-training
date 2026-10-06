# Connecting AI Assistants to Apex Training

Apex Training ships a remote [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) server at `https://<your-deployment>/api/mcp`, so AI
assistants — Claude Desktop, claude.ai, Claude Code, ChatGPT — can query your
training data directly in conversation: *"How did my squat progress this
block?"*, *"What's on my calendar this week?"*, *"Any PRs last month?"*

A connection can be **full** or **read-only** — you choose when you approve
it. A full connection lets the assistant act for you as well: *"Log today's
bench: 5×5 at 185"*, *"Move Thursday's run to Friday"*, *"Add a 40-minute easy
ride on Sunday"*, *"Log lunch: chicken, rice, 60 g protein"*. Every change an
assistant makes runs through the same server code the in-app coach uses, is
stamped as AI-made, is listed under **Profile → Coach activity**, and counts
against the same cap of 200 AI-made changes per day. A read-only connection
can only look.

New to Apex itself? [WELCOME.md](WELCOME.md) covers the rest of the app.

Prefer pictures? The app carries an illustrated version of this page under
**Profile → AI connector → ⓘ**, written for someone who has never heard of MCP:
annotated drawings of each Claude and ChatGPT screen, a glossary, and the
troubleshooting list below in plainer words. This file stays the reference —
the in-app guide is the walkthrough.

For the deployment at `apex-training.app`, the server URL is:

```
https://apex-training.app/api/mcp
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
whose data the assistant sees. The consent page says whether the connection
will be full or read-only (Claude asks for full access unless you configure
the connector with the `mcp:read` scope alone). Tokens expire hourly and
refresh automatically.

Claude asks before the first use of each tool in a conversation. The tools
that change data are annotated as such (`readOnlyHint: false`, with
`destructiveHint` on the ones that delete or overwrite), so you can allow the
read-only tools for a whole chat and keep approving each change.

**Connected before write access existed?** Your existing connection stays
read-only — a token never gains powers it was not granted. Disconnect it
under **Profile → Claude or ChatGPT** and connect again to get a full one.

## Claude Code (personal access token)

Mint a token in the Apex app under **Profile → Claude or ChatGPT** (it is
shown exactly once — copy it immediately). The **Can make changes** tick box
decides whether the token is full or read-only; that cannot be changed after
minting, and tokens minted before the box existed are read-only. Then:

```bash
claude mcp add --transport http apex https://apex-training.app/api/mcp \
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

ChatGPT asks for confirmation before any tool that is not marked read-only,
so each change — logging a workout, adding an event, deleting a meal — shows
you what is about to happen first. The read-only tools run without the prompt.

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
  npx mcp-remote https://apex-training.app/api/mcp \
    --header "Authorization: Bearer apx_..."
  ```

---

## What the assistant can do

### Reading (every connection)

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
| `get_session_summaries` | "What did the coach say after my last few sessions?" — the post-workout summaries, newest first |
| `get_reviews` | "How did last month go?" — stored monthly/yearly reviews: period, commentary, pre-computed stats |
| `get_profile` | "What's my goal line set to?" — display name, coach goal and context, coaching contract, HR settings |
| `get_workout_templates` | "What's in my library?" — the saved workouts, with scoring and exercise names |
| `get_notes` | "Anything pinned to this week?" — live coach notes on days, workouts and blocks |
| `get_coach_memory` | "What does the coach remember about my knee?" — the coach's long-term facts about you |

All numbers (estimated 1RM via Epley, tonnage, streaks, attainment) are
computed server-side by the same code the app itself uses — the assistant
cites them rather than deriving its own.

### Changing things (full connections only)

| Tool | Does |
|---|---|
| `create_event`, `update_event`, `delete_event` | Add a workout (a past date retro-logs it as done), change its fields or move one occurrence, delete it or skip one occurrence |
| `set_event_exercises` | Replace a workout's warmup, main or cooldown list (a series changes every occurrence) |
| `log_workout` | Record the sets and cardio actually done against the plan, then mark it complete — reports any PRs |
| `complete_workout`, `uncomplete_workout` | The calendar's "Mark as Complete" and its undo |
| `log_meal`, `update_meal`, `delete_meal` | Track meals with macros (the composer's own validation applies) |
| `create_exercise_definition`, `update_exercise_definition` | Add or edit a library exercise (renames keep history through aliases) |
| `create_training_block`, `update_training_block`, `delete_training_block` | Monday-to-Monday blocks with weekly targets |
| `create_objective`, `update_objective`, `delete_objective` | What the training is for |
| `leave_note`, `dismiss_note` | Pin or dismiss a note on a day, workout or block |
| `update_coach_memory` | Remember, change or forget a fact in the coach's memory |
| `propose_contract_edit` | Replace the coaching contract (refused if it changed since it was read) |
| `update_profile` | Display name, coach goal and context, max and threshold HR |

The event, exercise, meal, note, memory and contract tools are the in-app
coach's own executors — the ones the coach evals test — reached without the
confirmation card. That is the trade a full connection makes: the assistant's
own confirmation prompt stands in for Apex's card, so look at what it is about
to do before you allow it.

A write tool answers a read-only token with a message saying how to get write
access, never with a silent no-op; once the daily cap is reached every write
answers with that instead, and nothing is changed.

## Managing access

Everything lives in the Apex app under **Profile → Claude or ChatGPT**:

- **Connected apps** (OAuth): each connected client is listed with its access
  level and a disconnect button, which revokes every token that client holds.
- **Personal access tokens**: named, shown once at creation, revocable
  individually, each marked read-only when it is. The server stores only a hash.
- **Coach activity** (further down the profile) lists every change made
  through a connection, alongside the in-app coach's, with what changed.
- Claude's connector UI additionally lets you block individual tools per
  connector, and asks before the first use of each tool in a conversation.

Rate limiting: 300 MCP requests per hour per user, and at most 200 AI-made
changes per day across the connector and the in-app coach (the first time the
cap is hit, Apex emails you).

A note on trust: whatever the assistant reads in a conversation — a pasted
web page, a document, another tool's output — can try to steer it, and with a
full connection a steered assistant can change your training. The protections
are the ones above: the assistant's own per-tool confirmation, the activity
log, the daily cap, and the read-only option for a connection you do not need
to act through.

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
- **"This connection is read-only"** — the token was minted or the client
  connected without write access (or before it existed). Create a new code
  with **Can make changes** ticked, or disconnect and reconnect the app.
- **"Daily change cap reached"** — 200 AI-made changes since midnight UTC.
  Make the change in the app, or wait for the next day.

## For developers

Server code lives in [`api/_lib/mcp/`](api/_lib/mcp) (protocol, the query
tools under `tools/`, the write tools in `writeTools.ts`, the connector's
tool lists in `connectorRegistry.ts`) and [`api/_lib/handlers/`](api/_lib/handlers)
(`mcp.ts`, `mcpTokens.ts`, `oauth*.ts`), with the OAuth 2.1 pieces in
[`api/_lib/oauth/`](api/_lib/oauth). It is a stateless Streamable HTTP server
(2025-06-18 MCP revision): POST JSON-RPC in, JSON out, no SSE, no session ids.
Auth is a bearer token — either a personal access token or an OAuth access
token minted by the built-in authorization server (RFC 7591 dynamic client
registration, PKCE S256, RFC 9728/8414 discovery, rotating refresh tokens).
Scopes are `mcp:read` and `mcp:write`; a token's stored scope decides which
tools `tools/list` shows it and which `tools/call` runs, and a token with no
stored scope (minted before `mcp:write` existed) is read-only. The write
tools wrap the in-app coach's executors (`src/lib/coach/tools.ts`) over
`api/_lib/coach/toolDeps.ts` — the same door as `/api/coach-tool` — plus
native tools over `api/_lib/services/*` and `trackerSession.ts`. Tables:
`mcp_tokens` (phase 26), `oauth_clients` / `oauth_codes` (phase 28).
