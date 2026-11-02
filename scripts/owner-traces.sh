#!/usr/bin/env bash
# The owner loop's weekly digest (docs/specs/agent-ownership.md, M4). Read-only.
#
#   scripts/owner-traces.sh [--now YYYY-MM-DD] [--days N]
#
# Prints what the loop's own traces say about the last N days (default 7,
# ending today, local date): one fact per line, each tagged with the file or
# command it came from. The loop's Sunday Reflection cites these lines and
# produces no number of its own: the script computes, the run narrates.
#
# Sources, and the environment that redirects each one (the test uses them):
#   OWNER_TRACES_NOTES  the loop's notes, <vault>/AI/Projects/Apex Owner/Log/
#                       (one file per day, one "## HH:MM run" section per run)
#   OWNER_TRACES_STATE  the loop's state, <primary>/.claude/state/:
#                       owner-attempts.tsv, merge-log, stop-gate/<session>/<lane>.count
#   OWNER_TRACES_RUNS   a TSV standing in for `gh run list` on main
#                       (id, sha, conclusion, attempt, createdAt, event)
#   OWNER_TRACES_PRS    a TSV standing in for `gh pr list --label owner-loop`
#                       (number, createdAt, title)
# Needs bash, awk, sort and stat, plus gh when no stand-in is given. The
# babysitter writes only merges to merge-log; its HOLD and SKIP lines reach the
# loop's notes (step 8) and nowhere else, so that is where cycling is counted.
# Nothing this script reads is an instruction to anyone.
set -euo pipefail
export LC_ALL=C

now=""
days=7
while [ $# -gt 0 ]; do
  case "$1" in
    --now) now=${2:-}; shift 2 ;;
    --days) days=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "owner-traces: unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -n "$now" ] || now=$(date +%F)
if ! [[ "$now" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then echo "owner-traces: --now wants YYYY-MM-DD, got $now" >&2; exit 64; fi
if ! [[ "$days" =~ ^[1-9][0-9]*$ ]]; then echo "owner-traces: --days wants a positive integer, got $days" >&2; exit 64; fi

root=$(cd "$(dirname "$0")/.." && pwd -P)
if [ -n "${OWNER_TRACES_STATE:-}" ]; then
  state=$OWNER_TRACES_STATE
else
  primary=$(cd "$root" && cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
  state="$primary/.claude/state"
fi
notes_dir=${OWNER_TRACES_NOTES:-"$HOME/Documents/Obsidian Vault/AI/Projects/Apex Owner/Log"}

# Civil-date arithmetic in awk, so the window needs no date(1) dialect.
start=$(awk -v now="$now" -v days="$days" '
function days_from_civil(y, m, d,    era, yoe, doy, doe) {
  if (m <= 2) y--
  era = int(y / 400); yoe = y - era * 400
  doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}
function civil_from_days(z,    era, doe, yoe, y, doy, mp, d, m) {
  z += 719468
  era = int(z / 146097); doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400
  doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153)
  d = doy - int((153 * mp + 2) / 5) + 1
  m = mp + (mp < 10 ? 3 : -9)
  if (m <= 2) y++
  return sprintf("%04d-%02d-%02d", y, m, d)
}
BEGIN { split(now, a, "-"); print civil_from_days(days_from_civil(a[1] + 0, a[2] + 0, a[3] + 0) - (days - 1)) }')

in_window() { [[ "$1" > "$start" || "$1" == "$start" ]] && [[ ! "$1" > "$now" ]]; }

# The file's modification date, YYYY-MM-DD, BSD or GNU stat.
mtime_date() {
  stat -f %Sm -t %F "$1" 2>/dev/null || stat -c %y "$1" | cut -c1-10
}

echo "owner-traces: window $start..$now ($days days ending today, local date)"

# ── Notes ────────────────────────────────────────────────────────────────────
note_files=()
if [ -d "$notes_dir" ]; then
  for f in "$notes_dir"/????-??-??.md; do
    [ -e "$f" ] || continue
    d=$(basename "$f" .md)
    in_window "$d" && note_files+=("$f")
  done
fi
if [ ${#note_files[@]} -eq 0 ]; then
  echo "[notes $notes_dir] no notes in window"
  echo "[notes] landed 0 PRs; repaired 0 PRs; held or skipped: 0 lines over 0 PRs; needs-shane: 0 lines"
  echo "[notes] PRs held or skipped in more than one run: none"
else
  notes_out=$(awk -v dir="$notes_dir" -v dash="—" '
  function prs_in(line, seen, run,    pr, n) {
    gsub(/pull\//, "#", line)
    n = 0
    while (match(line, /#[0-9]+/)) {
      pr = substr(line, RSTART + 1, RLENGTH - 1)
      if (!((run, pr) in seen)) { seen[run, pr] = 1; n++; out[n] = pr }
      line = substr(line, RSTART + RLENGTH)
    }
    return n
  }
  FNR == 1 { files++ }
  /^## .* run$/ { runs++; sec = ""; next }
  /^## / { sec = ""; next }
  /^\*\*[^*]+\*\*/ { s = $0; sub(/^\*\*/, "", s); sub(/\*\*.*$/, "", s); sec = s
                     sub(/^\*\*[^*]*\*\*/, ""); sub("^[[:space:]]*(" dash "|-|:)?[[:space:]]*", "") }
  sec == "" || runs == 0 { next }
  {
    line = $0; sub(/^[[:space:]]*(-[[:space:]]+)?/, "", line)
    low = tolower(line); sub(/[.[:space:]]*$/, "", low)
    if (line == "" || low == "nothing" || low == "none" || low == "no deploy") next
    if (sec == "Landed") { n = prs_in(line, landed_seen, runs); for (i = 1; i <= n; i++) if (!(out[i] in landed)) { landed[out[i]] = 1; landed_list = landed_list " #" out[i] } }
    else if (sec == "Repaired") { n = prs_in(line, rep_seen, runs); for (i = 1; i <= n; i++) if (!(out[i] in repaired)) { repaired[out[i]] = 1; rep_list = rep_list " #" out[i] } }
    else if (sec == "Held / skipped") {
      held_lines++
      n = prs_in(line, held_seen, runs)
      for (i = 1; i <= n; i++) { if (!(out[i] in held_runs)) held_pr_count++; held_runs[out[i]]++ }
    }
    else if (sec == "Needs Shane") needs_lines++
  }
  END {
    printf "[notes %s] %d run sections in %d daily notes\n", dir, runs, files
    lc = 0; for (p in landed) lc++
    rc = 0; for (p in repaired) rc++
    printf "[notes] landed %d PRs%s; repaired %d PRs%s; held or skipped: %d lines over %d PRs; needs-shane: %d lines\n", lc, (lc ? " (" substr(landed_list, 2) ")" : ""), rc, (rc ? " (" substr(rep_list, 2) ")" : ""), held_lines + 0, held_pr_count + 0, needs_lines + 0
    for (p in held_runs) if (held_runs[p] > 1) printf "CYC\t%s\t%d\n", p, held_runs[p]
  }' "${note_files[@]}")
  printf '%s\n' "$notes_out" | grep -v '^CYC' || true
  cyc=$(printf '%s\n' "$notes_out" | awk -F'\t' '$1 == "CYC" { print $2 "\t" $3 }' | sort -n \
    | awk -F'\t' '{ printf "%s#%s (%d runs)", (NR > 1 ? "; " : ""), $1, $2 } END { if (!NR) printf "none" }')
  echo "[notes] PRs held or skipped in more than one run: $cyc"
fi

# ── Attempts ledger ──────────────────────────────────────────────────────────
ledger="$state/owner-attempts.tsv"
if [ ! -f "$ledger" ]; then
  echo "[attempts $ledger] no ledger yet (file missing)"
else
  ledger_out=$(awk -F'\t' -v start="$start" -v now="$now" '
  $1 >= start && $1 <= now && $2 != "" {
    n++; pr = $2; sub(/^#/, "", pr)
    if (!(pr in prs)) { prs[pr] = 1; pc++ }
    day[$1, pr]++
    if (day[$1, pr] == 2) printf "LIMIT\t%s\t%s\n", $1, pr
  }
  END { printf "TOTAL\t%d\t%d\n", n + 0, pc + 0 }' "$ledger")
  totals=$(printf '%s\n' "$ledger_out" | awk -F'\t' '$1 == "TOTAL" { printf "%d attempts on %d PRs", $2, $3 }')
  limit=$(printf '%s\n' "$ledger_out" | awk -F'\t' '$1 == "LIMIT" { print $2 "\t" $3 }' | sort \
    | awk -F'\t' '{ printf "%s#%s on %s", (NR > 1 ? "; " : ""), $2, $1 } END { if (!NR) printf "none" }')
  echo "[attempts $ledger] $totals; at the daily limit (2 in a day): $limit"
fi

# ── Merge log ────────────────────────────────────────────────────────────────
mlog="$state/merge-log"
if [ ! -f "$mlog" ]; then
  echo "[merge-log $mlog] file missing"
else
  awk -v start="$start" -v now="$now" -v file="$mlog" '
  substr($1, 1, 10) >= start && substr($1, 1, 10) <= now && $2 == "merged" { n++; list = list " " $3 }
  END { printf "[merge-log %s] %d merges%s\n", file, n + 0, (n ? " (" substr(list, 2) ")" : "") }' "$mlog"
fi

# ── Stop gate ────────────────────────────────────────────────────────────────
sg="$state/stop-gate"
red_lines=""; red_sessions=0; blocked=0
if [ -d "$sg" ]; then
  for d in "$sg"/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d"); session_red=0
    for c in "$d"*.count; do
      [ -f "$c" ] || continue
      in_window "$(mtime_date "$c")" || continue
      read -r sha at total < "$c" || true
      lane=$(basename "$c" .count)
      red_lines+=$(printf '%s %s red %s (%s at %s)' "${id:0:8}" "$lane" "${total:-0}" "${at:-0}" "${sha:0:7}")$'\n'
      session_red=1
    done
    [ $session_red -eq 1 ] && red_sessions=$((red_sessions + 1))
    if [ -f "$d/blocked" ] && in_window "$(mtime_date "$d/blocked")"; then blocked=$((blocked + 1)); fi
  done
fi
if [ $red_sessions -eq 0 ]; then
  echo "[stop-gate $sg] 0 sessions with red gate runs; blocked passes present: $blocked"
else
  echo "[stop-gate $sg] $red_sessions sessions with red gate runs: $(printf '%s' "$red_lines" | sort | tr '\n' ';' | sed -e 's/;$//' -e 's/;/; /g'); blocked passes present: $blocked"
fi

# ── CI on main ───────────────────────────────────────────────────────────────
ci_src="gh run list --branch main --workflow ci.yml"
if [ -n "${OWNER_TRACES_RUNS:-}" ]; then
  runs_tsv=$(cat "$OWNER_TRACES_RUNS"); ci_src="$OWNER_TRACES_RUNS"
elif ! runs_tsv=$(gh run list --branch main --workflow ci.yml --limit 200 \
    --json databaseId,headSha,conclusion,attempt,createdAt,event \
    --template '{{range .}}{{printf "%.0f" .databaseId}}{{"\t"}}{{.headSha}}{{"\t"}}{{.conclusion}}{{"\t"}}{{.attempt}}{{"\t"}}{{.createdAt}}{{"\t"}}{{.event}}{{"\n"}}{{end}}' 2>/dev/null); then
  runs_tsv=""; ci_src="$ci_src (failed; is gh signed in?)"
fi
printf '%s\n' "$runs_tsv" | awk -F'\t' -v start="$start" -v now="$now" -v src="$ci_src" '
  NF >= 5 && substr($5, 1, 10) >= start && substr($5, 1, 10) <= now { print }' | sort -t "$(printf '\t')" -k5,5 | awk -F'\t' -v src="$ci_src" '
  {
    n++; sha = $2; c = $3; att = $4 + 0; when = substr($5, 1, 10)
    if (c == "success") s++; else if (c == "failure") f++; else if (c == "cancelled") k++; else o++
    if (!(sha in seen)) { seen[sha] = 1; order[++ns] = sha }
    if (c == "failure") {
      if (!(sha in failed_at)) failed_at[sha] = when
      if ((sha in passed_at) && !(sha in pf)) pf[sha] = sprintf("%s (success %s then failure %s, %s)", substr(sha, 1, 7), passed_at[sha], when, $6)
    }
    if (c == "success") {
      if (!(sha in passed_at)) passed_at[sha] = when
      if ((sha in failed_at) && !(sha in flip)) flip[sha] = sprintf("%s (failure %s then success %s)", substr(sha, 1, 7), failed_at[sha], when)
      if (att > 1 && !(sha in rerun)) rerun[sha] = sprintf("%s attempt %d", substr(sha, 1, 7), att)
    }
    last[sha] = c; last_when[sha] = when
    latest = sprintf("%s %s %s", c, substr(sha, 1, 7), when)
  }
  END {
    printf "[ci %s] %d runs: %d success, %d failure, %d cancelled, %d other; latest %s\n", src, n + 0, s + 0, f + 0, k + 0, o + 0, (n ? latest : "none")
    a = ""; b = ""; p = ""; r = ""
    for (i = 1; i <= ns; i++) {
      sha = order[i]
      if (sha in flip) a = a "; " flip[sha]
      if (sha in rerun) b = b "; " rerun[sha]
      if (sha in pf) p = p "; " pf[sha]
      if (last[sha] == "failure") r = r "; " substr(sha, 1, 7) " " last_when[sha]
    }
    printf "[ci] failed then passed on the same commit: %s\n", (a == "" ? "none" : substr(a, 3))
    printf "[ci] passed on a rerun: %s\n", (b == "" ? "none" : substr(b, 3))
    printf "[ci] passed then failed on the same commit: %s\n", (p == "" ? "none" : substr(p, 3))
    printf "[ci] red at its last run: %s\n", (r == "" ? "none" : substr(r, 3))
  }'

# ── Open owner-loop PRs ──────────────────────────────────────────────────────
pr_src="gh pr list --label owner-loop --state open"
if [ -n "${OWNER_TRACES_PRS:-}" ]; then
  prs_tsv=$(cat "$OWNER_TRACES_PRS"); pr_src="$OWNER_TRACES_PRS"
elif ! prs_tsv=$(gh pr list --label owner-loop --state open --json number,createdAt,title \
    --template '{{range .}}{{.number}}{{"\t"}}{{.createdAt}}{{"\t"}}{{.title}}{{"\n"}}{{end}}' 2>/dev/null); then
  prs_tsv=""; pr_src="$pr_src (failed; is gh signed in?)"
fi
printf '%s\n' "$prs_tsv" | awk -F'\t' -v src="$pr_src" '
  NF >= 2 && $1 != "" { n++; list = list "; #" $1 " (opened " substr($2, 1, 10) ") " $3 }
  END { printf "[prs %s] %d open%s\n", src, n + 0, (n ? ":" substr(list, 2) : "") }'
