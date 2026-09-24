# O06 — Research: can the coach run on a Claude subscription?

**Wave:** 1 · **Depends on:** — · **Unblocks:** D-O06
**Status:** ready · read-only lane · report → `docs/onboarding/research/anthropic-subscription-oauth.md`

## Question
Shane asked the API-key help page to cover users who already pay for Claude ("an OAuth key
if they already have a subscription"). Is there any supported way for a third-party web app
(Apex, Vercel serverless, per-user) to run Claude requests on a user's claude.ai
subscription instead of a console API key? If not today, what is the closest honest thing to
tell a subscriber, and what would have to change for it to become possible?

## Scope
Look at: Anthropic's public docs and terms for the Claude API, Claude Code and the Agent SDK
(the repo already runs its eval gate on a subscription through the Agent SDK with
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` — `docs/ios/decisions.md` D-047 — on a
developer machine); the `ant auth login` OAuth profiles (console-org scoped, still
API-billed); any published policy on unattended or third-party use of subscription
entitlement. Do not: write code, call any API, or spend tokens.

## Report (≤ 60 lines)
Conclusions first, each with a URL. Separate "supported today" from "technically works but
unsupported/against terms" from "not possible". End with the sentence the help page should
use for subscribers and a recommendation for D-O06.

## Session log
