#!/usr/bin/env bash
# The agent-facing side of the Stop hook (scripts/hooks/stop-gate.mjs).
#
#   scripts/stop-gate.sh status                 # lanes this session is bound to, budgets, last gate log
#   scripts/stop-gate.sh bind [<worktree>]      # bind this session to a lane (git-new.sh does this for you)
#   scripts/stop-gate.sh unbind [<worktree>]    # drop one lane, or every lane and the session's counters
#   scripts/stop-gate.sh blocked "<reason>"     # let exactly one stop through, on the record
#
# `blocked` is the only way to stop early on purpose: an irreversible action
# that needs Shane, or an ambiguity that changes the design. The reason is
# written where the hook reads it and echoed back so it lands in the
# transcript; the next stop goes through, the one after that is gated again.
#
# The session is CLAUDE_CODE_SESSION_ID, which Claude Code sets in every Bash
# subprocess and which equals the session_id the hook receives. Subagents
# share their parent's id, so an orchestrator that cuts several lanes is
# bound to all of them: a binding is one worktree per line.
set -euo pipefail

root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
sid="${CLAUDE_CODE_SESSION_ID:-}"
state="$root/.claude/state"
cmd="${1:-status}"
shift || true

need_sid() {
  if [ -z "$sid" ]; then
    echo "stop-gate: CLAUDE_CODE_SESSION_ID is not set — not running under Claude Code? Nothing to $cmd." >&2
    exit 1
  fi
  case "$sid" in */*|*..*) echo "stop-gate: refusing session id '$sid'" >&2; exit 1 ;; esac
}

# A linked worktree of THIS repo: its .git is a file, and its common dir is ours.
lane_of_repo() {
  [ -f "$1/.git" ] || return 1
  local common
  common=$(cd "$1" && git rev-parse --git-common-dir 2>/dev/null) || return 1
  [ "$(cd "$1" && cd "$common" && pwd -P)" = "$root/.git" ]
}

case "$cmd" in
  status)
    echo "session:  ${sid:-(not under Claude Code)}"
    if [ -n "$sid" ] && [ -s "$state/sessions/$sid" ]; then
      while read -r wt; do [ -n "$wt" ] && echo "lane:     $wt"; done < "$state/sessions/$sid"
    else
      echo "lane:     (none bound — git-new.sh binds, or: scripts/stop-gate.sh bind <worktree>)"
    fi
    if [ -n "$sid" ] && [ -d "$state/stop-gate/$sid" ]; then
      g="$state/stop-gate/$sid"
      [ -f "$g/blocked" ] && echo "pending:  one stop will be let through — $(cat "$g/blocked")"
      for f in "$g"/*.count; do
        [ -f "$f" ] || continue
        read -r sha at total < "$f"
        echo "red runs: $(basename "$f" .count) — $at at ${sha:0:7}, $total this session (caps ${STOP_GATE_MAX_RED_RUNS:-3}/${STOP_GATE_MAX_RED_TOTAL:-10})"
      done
      for f in "$g"/*.green; do [ -f "$f" ] && echo "green:    $(basename "$f" .green) at $(cut -c1-7 "$f")"; done
      for f in "$g"/*.gate.log; do [ -f "$f" ] && echo "gate log: $f"; done
    fi
    true
    ;;
  bind)
    need_sid
    wt="${1:-$(pwd -P)}"
    wt=$(cd "$wt" && pwd -P)
    if ! lane_of_repo "$wt"; then
      echo "stop-gate: $wt is not a linked worktree of this repo — refusing (the primary checkout is never a lane)" >&2
      exit 1
    fi
    mkdir -p "$state/sessions"
    if [ -f "$state/sessions/$sid" ] && grep -qxF "$wt" "$state/sessions/$sid"; then
      echo "stop-gate: session already bound to $wt"
    else
      printf '%s\n' "$wt" >> "$state/sessions/$sid"
      echo "stop-gate: session bound to $wt — stopping now requires it clean, green and pushed"
    fi
    ;;
  unbind)
    need_sid
    if [ -n "${1:-}" ]; then
      wt=$(cd "$1" && pwd -P)
      if [ -f "$state/sessions/$sid" ]; then
        grep -vxF "$wt" "$state/sessions/$sid" > "$state/sessions/$sid.tmp" || true
        mv "$state/sessions/$sid.tmp" "$state/sessions/$sid"
      fi
      rm -f "$state/stop-gate/$sid/$(basename "$wt")".*
      echo "stop-gate: $wt unbound"
    else
      rm -rf "$state/sessions/$sid" "$state/stop-gate/$sid"
      echo "stop-gate: session unbound"
    fi
    ;;
  blocked)
    need_sid
    reason="${1:-}"
    if [ -z "$reason" ]; then
      echo "usage: scripts/stop-gate.sh blocked \"<why this session must stop before it is done>\"" >&2
      exit 64
    fi
    mkdir -p "$state/stop-gate/$sid"
    printf '%s — %s\n' "$(date -u +%FT%TZ)" "$reason" > "$state/stop-gate/$sid/blocked"
    echo "stop-gate: BLOCKED — $reason"
    echo "stop-gate: the next stop goes through. Say the same thing in your report so Shane sees it."
    ;;
  *)
    echo "usage: scripts/stop-gate.sh status | bind [<worktree>] | unbind [<worktree>] | blocked \"<reason>\"" >&2
    exit 64
    ;;
esac
