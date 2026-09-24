# O16 — Verification, external screenshots, close-out

**Wave:** 3 · **Depends on:** every wave-2 lane merged · **Unblocks:** the iOS parity session
**Status:** ready · orchestrator + verifiers · ports 5241–5244

## Parts
1. **Copy audit** (read-only lane). Every tip and page against MASTER.md, "Copy rules":
   mechanical word counts, banned-word grep, one-verb check, button labels verified against
   the component source. Output: a table of violations with file:line → small fix lanes.
2. **Fresh-profile walk** (`app-verifier`, `Lane:` line required, port 5242) on the folded
   tree at 375×812 and 1280×950: the four cards → Copy the starter plan → open a workout →
   Start Workout → Finish → the coach; each expected tip fires exactly once; `/help/*` render
   signed out; no tip over WelcomeFlow; keyboard and Escape behaviour; no horizontal scroll.
3. **External screenshots** (orchestrator, serialized, Claude-in-Chrome with Shane signed
   in; branch `feat/help-external-shots`). Capture every `EXTERNAL:` placeholder across
   `help/get-api-key.md`, `help/connect-coros.md`, `help/calendar-feed.md` at the stated
   viewport; redact as stated; Shane reviews each PNG before it is committed; remove the
   placeholder comments; `documents.test.ts` goes strict for those files.
4. **Close-out** (orchestrator): `WELCOME.md` refreshed (its "On a phone" section is stale —
   the bottom nav is Calendar / + / Coach / Analytics — and it now mirrors `/help`);
   STATUS.md and decisions.md current; `scripts/git-tidy.sh --yes`; prod verify —
   `curl -sI https://apextrainingcalendar.vercel.app/help/get-api-key` → 200 HTML, one PNG →
   200 image/png; `scripts/supervisor-report.sh` clean. Then a fresh-account walk on prod
   (Shane creates a throwaway invite).

## Session log
