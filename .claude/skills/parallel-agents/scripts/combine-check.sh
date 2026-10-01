#!/usr/bin/env bash
# Prove that several lanes combine before their PRs open.
#
#   combine-check.sh feat/a feat/b feat/c                   # pairwise textual check
#   combine-check.sh --check "npm ci && npm test" a b c     # + fold all, run the command on the fold
#   combine-check.sh --sequential --check "make test" a b   # fold in merge order only (no pairs)
#   combine-check.sh --against feat/dep a b [--check CMD]   # pairs dep × a, dep × b; fold base + dep only
#   combine-check.sh --baseline --check "make test" a b     # fold fails → rerun CMD on base to compare
#
# Flags (each at most once; a flag's value may not be empty, blank, or look like a flag):
#   --check CMD     fold every branch onto the default branch in the order given
#                   and run CMD in a throwaway detached worktree, in a fresh
#                   `bash -c` with default shell options (no -e, -u, pipefail),
#                   stdin from /dev/null, in its own process group.
#   --sequential    skip the pairwise check; fold in order only.
#   --against REF   pairwise only between REF and each listed branch (N pairs,
#                   not N²/2). With --check, the fold is base + REF only; the
#                   listed branches are not folded. Not combinable with --sequential.
#   --baseline      with --check: if CMD fails on the fold, say so without
#                   blaming anyone yet and run it on the base commit in another
#                   throwaway worktree; the "baseline:" line is the verdict. Base fails too → exit 3
#                   (the lanes may still have broken it too: compare the failures);
#                   base passes → exit 1; CMD cannot run on base (exit 126 or 127,
#                   e.g. it runs test files the lanes add) → "baseline:
#                   inconclusive", exit 1. Ignored without --check.
#
# Environment: COMBINE_GIT_TIMEOUT  seconds allowed for each network step
#   (fetch, ls-remote; default 60). Prompts and credential helpers are disabled
#   for them. A fetch that times out falls back to local refs with a WARN.
#
# The repository is the one the invoking directory belongs to (inside a
# submodule: the submodule); a bare-repository layout → exit 64.
#
# Arguments are branch names, or full or short commit SHAs. HEAD, @ and refs
# relative to them (HEAD~1, @{-1}, …) and git's special refs (FETCH_HEAD,
# ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, BISECT_HEAD)
# resolve in the invoking directory's checkout before the fetch; @{u},
# @{upstream} and @{push} (optionally prefixed, e.g. feat/a@{u}) resolve there
# after it. Any other name resolves as refs/remotes/origin/<name> when that
# exists (a local branch named origin/<name> never shadows it), else as given
# (so local, unpushed lanes work too); if a local branch <name> sits at a
# different commit than origin/<name>, a WARN goes to stderr and the pin line
# names the source: "ref  <name> (origin/<name>) = <sha>". Every ref and the
# base are pinned to a full SHA before anything runs, and the pins are printed
# ("base <def> = <sha>", "ref  <name> = <sha>"): what was tested is exactly
# those commits, whatever the branches do meanwhile.
#
# The base is origin/HEAD, else the remote's HEAD per `git ls-remote --symref
# origin HEAD`; neither (or ls-remote timing out) → exit 64, never a guessed
# origin/main. The fold starts from it, so the tree tested is what main would
# hold after every lane lands.
#
# Pairwise `git merge-tree` finds branches that each merge cleanly into main
# but conflict with each other; a merge-tree failure other than a conflict
# (e.g. unrelated histories) is reported "ERROR a × b: <git's message>" and the
# remaining pairs still run. The fold finds semantic collisions — one lane
# tightens a rule, another adds code it rejects — that no textual check sees.
# The fold proves exactly what the command runs and nothing else; say so.
# CMD's exit code is printed; 126/127 on the fold means the check cannot run
# there (exit 1, no baseline). One branch with no --check, --against or
# --sequential checks nothing: said on stderr, exit 0.
#
# Throwaway worktrees are created with unique names under
# <primary>/.claude/worktrees/_combine-*; only those this run created (and
# their registrations) are ever removed — no global `git worktree prune` —
# always on exit, unlocked and made writable first. A throwaway that cannot be
# removed gets a WARN; it never changes the exit code. When CMD returns, any
# process it left running in its process group is stopped (TERM, then KILL
# after 2 s). INT, TERM and HUP freeze CMD and everything it started (STOP on
# its process group), remove the throwaways, then terminate the group.
#
# Exit: 0 all clean (or nothing to check); 1 a conflict, a merge-tree error, a
# failure caused by the lanes, a check that cannot run, or an inconclusive
# baseline; 2 unexpected internal failure ("combine-check: error: <step>:
# <message>"; 1 instead if a pairwise conflict or error was already found);
# 3 CMD fails on the fold and on the base too, with an exit other than 126/127
# (--baseline); 64 usage; 129/130/143 killed by HUP/INT/TERM. Needs git >= 2.38.
set -euo pipefail

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" >&2
  exit 64
}
uerr() { echo "combine-check: $1" >&2; exit 64; }
status=0
# An internal failure never hides a conflict already found (exit 1 then, else 2).
die() {
  echo "combine-check: error: $1: $2" >&2
  if [ "$status" -eq 1 ]; then exit 1; fi
  exit 2
}
trap 'die "line $LINENO" "unexpected command failure (exit $?)"' ERR

check_cmd="" sequential=0 against="" baseline=0 branches=()
seen=" "
once() { case "$seen" in *" $1 "*) uerr "$1 given more than once" ;; esac; seen="$seen$1 "; }
value() {  # value <flag> <argc> <value?>
  [ "$2" -ge 2 ] || uerr "$1 needs a value"
  case "$3" in *[![:space:]]*) ;; *) uerr "$1 needs a non-blank value" ;; esac
  case "$3" in -*) uerr "$1 needs a value, got the flag-like '$3'" ;; esac
}
while [ $# -gt 0 ]; do
  case "$1" in
    --check) once "$1"; value "$1" $# "${2-}"; check_cmd=$2; shift 2 ;;
    --against) once "$1"; value "$1" $# "${2-}"; against=$2; shift 2 ;;
    --sequential) once "$1"; sequential=1; shift ;;
    --baseline) once "$1"; baseline=1; shift ;;
    -*) usage ;;
    *) branches+=("$1"); shift ;;
  esac
done
[ "${#branches[@]}" -ge 1 ] || uerr "name at least one branch"
if [ -n "$against" ] && [ "$sequential" -eq 1 ]; then uerr "--against and --sequential cannot be combined"; fi
if [ "$baseline" -eq 1 ] && [ -z "$check_cmd" ]; then
  echo "combine-check: note — --baseline has no effect without --check" >&2
fi
net_timeout=${COMBINE_GIT_TIMEOUT:-60}
case "$net_timeout" in '' | *[!0-9]* | 0) uerr "COMBINE_GIT_TIMEOUT must be a positive integer (seconds)" ;; esac

# The repository the invoking directory belongs to, and its primary checkout.
inv=$(pwd -P)
[ "$(git rev-parse --is-bare-repository 2>/dev/null)" != true ] || uerr "this is a bare repository; run from a checkout"
gcd=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || uerr "not inside a git repository"
if [ "$(git config --file "$gcd/config" --bool core.bare 2>/dev/null)" = true ]; then
  uerr "bare-repository layout ($gcd has no primary checkout); run from a non-bare clone"
fi
if wtcfg=$(git config --file "$gcd/config" core.worktree 2>/dev/null); then
  # A submodule (or --separate-git-dir) repository: core.worktree names the checkout.
  root=$(cd "$gcd" && cd "$wtcfg" && pwd -P) || uerr "core.worktree '$wtcfg' in $gcd does not exist"
elif [ "${gcd##*/}" = .git ]; then
  root=$(cd "$gcd/.." && pwd -P) || uerr "cannot enter the primary checkout of $gcd"
else
  uerr "cannot find the primary checkout for $gcd (unrecognised repository layout)"
fi

tmpd="" made_wts=() cmd_pid="" net_pid=""
# stop_group <pid>: TERM (and CONT, in case it is frozen) the process group led
# by <pid>, KILL what is left after 2 s.
stop_group() {
  local i=0
  kill -TERM -- "-$1" 2>/dev/null || return 0
  kill -CONT -- "-$1" 2>/dev/null || true
  while kill -0 -- "-$1" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
  kill -KILL -- "-$1" 2>/dev/null || true
}
# unregister <path>: drop the admin entry of this run's throwaway at <path> if
# git still lists it (its directory is gone). Never a global `worktree prune`:
# other worktrees' registrations (e.g. on an unmounted drive) are not ours.
unregister() {
  local adm
  for adm in "$gcd"/worktrees/*; do
    [ -f "$adm/gitdir" ] || continue
    if [ "$(cat "$adm/gitdir" 2>/dev/null)" = "$1/.git" ]; then rm -rf -- "$adm"; fi
  done
}
# Cleanup never changes the verdict: it keeps the exit code it was called with.
on_exit() {
  local rc=$? w frozen=""
  set +e
  trap - ERR
  # Interrupted while CMD runs: freeze its whole group so nothing writes into
  # the throwaways while they are removed; terminate it right after.
  if [ -n "$cmd_pid" ]; then frozen=$cmd_pid; cmd_pid=""; kill -STOP -- "-$frozen" 2>/dev/null; fi
  if [ -n "$net_pid" ]; then kill -TERM "$net_pid" 2>/dev/null; fi
  for w in ${made_wts[@]+"${made_wts[@]}"}; do
    git -C "$root" worktree unlock "$w" >/dev/null 2>&1
    chmod -R u+w "$w" >/dev/null 2>&1
    if ! git -C "$root" worktree remove --force "$w" >/dev/null 2>&1; then
      case "$w" in "$root"/.claude/worktrees/_combine-*) rm -rf -- "$w" >/dev/null 2>&1 ;; esac
    fi
    if [ -e "$w" ]; then
      echo "WARN could not remove throwaway worktree $w — remove it by hand (git worktree remove --force)" >&2
    else
      unregister "$w"
    fi
  done
  if [ -n "$frozen" ]; then stop_group "$frozen"; fi
  if [ -n "$tmpd" ]; then rm -rf -- "$tmpd" >/dev/null 2>&1; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
tmpd=$(mktemp -d "${TMPDIR:-/tmp}/combine-check.XXXXXX") || die "create temp dir" "mktemp failed"
errf="$tmpd/stderr"

# gx <step> <git args…>: run git; stdout → $gout; any failure → die naming the step.
gout=""
gx() {
  local step=$1 rc=0
  shift
  gout=$(git "$@" 2>"$errf") || rc=$?
  if [ "$rc" -ne 0 ]; then die "$step" "$(errmsg "git exit $rc")"; fi
}
errmsg() { awk 'NF { printf "%s%s", s, $0; s = "; " } END { if (!NR) printf "%s", d }' d="$1" "$errf"; }

# bounded <cmd…>: run a network git step for at most $net_timeout seconds
# (no GNU timeout needed); returns its exit code, or 124 if it was stopped.
bounded() {
  local rc=0 wd mark="$tmpd/timed-out"
  rm -f "$mark"
  env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/echo SSH_ASKPASS=/bin/echo \
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}" \
    git -c credential.helper= -c core.askPass= "$@" </dev/null &
  net_pid=$!
  (
    i=0
    while kill -0 "$net_pid" 2>/dev/null; do
      if [ "$i" -ge "$net_timeout" ]; then
        : > "$mark"
        pkill -TERM -P "$net_pid" 2>/dev/null || true
        kill -TERM "$net_pid" 2>/dev/null || true
        sleep 2
        pkill -KILL -P "$net_pid" 2>/dev/null || true
        kill -KILL "$net_pid" 2>/dev/null || true
        exit 0
      fi
      sleep 1
      i=$((i + 1))
    done
  ) >/dev/null 2>&1 &
  wd=$!
  wait "$net_pid" || rc=$?
  net_pid=""
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ -f "$mark" ]; then return 124; fi
  return "$rc"
}

# Refs that name the invoking checkout's state. is_rel: resolve before the
# fetch; is_up: the upstream/push forms, resolved after it.
is_up() {
  case "$1" in *"@{"[uU]"}"* | *"@{"[uU][pP][sS][tT][rR][eE][aA][mM]"}"* | *"@{"[pP][uU][sS][hH]"}"*) return 0 ;; esac
  return 1
}
is_rel() {
  case "$1" in
    HEAD | HEAD[~^@:]* | @ | @[~^]* | "@{"*) return 0 ;;
    FETCH_HEAD | ORIG_HEAD | MERGE_HEAD | CHERRY_PICK_HEAD | REVERT_HEAD | REBASE_HEAD | BISECT_HEAD) return 0 ;;
    FETCH_HEAD[~^@:]* | ORIG_HEAD[~^@:]* | MERGE_HEAD[~^@:]* | CHERRY_PICK_HEAD[~^@:]*) return 0 ;;
    REVERT_HEAD[~^@:]* | REBASE_HEAD[~^@:]* | BISECT_HEAD[~^@:]*) return 0 ;;
  esac
  return 1
}
inv_sha() {  # inv_sha <name> → $pinned, resolved in the invoking directory, or exit 64
  pinned=$(git -C "$inv" rev-parse --verify --quiet "$1^{commit}" 2>/dev/null) || uerr "cannot resolve '$1' in $inv"
}
refs=() labels=()
pinned=""
for idx in "${!branches[@]}"; do
  refs[idx]="" labels[idx]=${branches[idx]}
  if ! is_up "${branches[idx]}" && is_rel "${branches[idx]}"; then inv_sha "${branches[idx]}"; refs[idx]=$pinned; fi
done
against_sha="" against_label=$against
if [ -n "$against" ] && ! is_up "$against" && is_rel "$against"; then inv_sha "$against"; against_sha=$pinned; fi

cd "$root"
rc=0
bounded fetch origin --prune --quiet || rc=$?
case "$rc" in
  0) ;;
  124) echo "WARN fetch from origin timed out after ${net_timeout}s; using local refs" >&2 ;;
  *) echo "combine-check: warning — fetch failed; using local refs" >&2 ;;
esac

for idx in "${!branches[@]}"; do
  if is_up "${branches[idx]}"; then inv_sha "${branches[idx]}"; refs[idx]=$pinned; fi
done
if [ -n "$against" ] && is_up "$against"; then inv_sha "$against"; against_sha=$pinned; fi

# Default branch, always as a remote-tracking ref (never a local look-alike).
if def_ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then :
else
  rc=0
  bounded ls-remote --symref origin HEAD >"$tmpd/ls-remote" 2>/dev/null || rc=$?
  if [ "$rc" -eq 124 ]; then
    uerr "cannot determine the default branch: origin/HEAD is not set and 'git ls-remote --symref origin HEAD' timed out after ${net_timeout}s (fix: git remote set-head origin <branch>)"
  fi
  remote_head=$(awk '$1 == "ref:" && $3 == "HEAD" { sub(/^refs\/heads\//, "", $2); print $2; exit }' "$tmpd/ls-remote")
  if [ "$rc" -ne 0 ] || [ -z "$remote_head" ]; then
    uerr "cannot determine the default branch: origin/HEAD is not set and 'git ls-remote --symref origin HEAD' names no HEAD (fix: git remote set-head origin --auto)"
  fi
  def_ref="refs/remotes/origin/$remote_head"
fi
def=${def_ref#refs/remotes/}
base=$(git rev-parse --verify --quiet "$def_ref^{commit}" 2>/dev/null) \
  || uerr "default branch $def does not resolve to a commit (fetch it, or git remote set-head origin --auto)"

# pin <name>: $pinned = full SHA, $pin_label = name for the pin line. Returns 1 if unresolvable.
pin_label=""
pin() {
  local lsha
  pin_label=$1
  if pinned=$(git rev-parse --verify --quiet "refs/remotes/origin/$1^{commit}" 2>/dev/null); then
    if lsha=$(git rev-parse --verify --quiet "refs/heads/$1^{commit}" 2>/dev/null) && [ "$lsha" != "$pinned" ]; then
      echo "WARN $1: local ${lsha:0:12} differs from origin/$1 ${pinned:0:12}; testing origin" >&2
      pin_label="$1 (origin/$1)"
    fi
    return 0
  fi
  case "$1" in
    origin/?*) if pinned=$(git rev-parse --verify --quiet "refs/remotes/$1^{commit}" 2>/dev/null); then return 0; fi ;;
  esac
  if pinned=$(git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null); then return 0; fi
  echo "combine-check: cannot resolve '$1'" >&2
  return 1
}
for idx in "${!branches[@]}"; do
  if [ -z "${refs[idx]}" ]; then
    pin "${branches[idx]}" || exit 64
    refs[idx]=$pinned labels[idx]=$pin_label
  fi
done
if [ -n "$against" ] && [ -z "$against_sha" ]; then
  pin "$against" || exit 64
  against_sha=$pinned against_label=$pin_label
fi

echo "── pinned"
echo "   base $def = $base"
if [ -n "$against" ]; then echo "   ref  $against_label = $against_sha"; fi
for idx in "${!refs[@]}"; do echo "   ref  ${labels[idx]} = ${refs[idx]}"; done

n=${#refs[@]}
if [ "$n" -eq 1 ] && [ -z "$check_cmd" ] && [ -z "$against" ] && [ "$sequential" -eq 0 ]; then
  echo "nothing to check: one branch and no --check" >&2
  exit 0
fi

# new_wt <tag> <commit>: a fresh detached throwaway worktree at <commit>, at a
# unique path this run created (mktemp); sets $wt.
wt=""
new_wt() {
  mkdir -p "$root/.claude/worktrees" 2>"$errf" || die "create throwaway worktree" "$(errmsg "mkdir failed")"
  wt=$(mktemp -d "$root/.claude/worktrees/_combine-$1.XXXXXX" 2>"$errf") \
    || die "create throwaway worktree" "$(errmsg "mktemp failed")"
  made_wts+=("$wt")
  gx "create throwaway worktree" worktree add --detach --quiet "$wt" "$2"
}
# run_cmd: CMD in $wt — fresh bash, default options, own process group (so a
# signal to this script can stop all of it); exit code → $cmd_rc. Anything CMD
# leaves running in its group is stopped when it returns.
cmd_rc=0
run_cmd() {
  local p
  cmd_rc=0
  set -m
  (cd "$wt" && exec env -u SHELLOPTS -u BASHOPTS bash -c "$check_cmd") </dev/null &
  cmd_pid=$!
  set +m
  wait "$cmd_pid" || cmd_rc=$?
  p=$cmd_pid
  cmd_pid=""
  stop_group "$p"
}

pair() {  # pair <label-a> <sha-a> <label-b> <sha-b>
  local out rc=0
  out=$(git merge-tree --write-tree --name-only "$2" "$4" 2>"$errf") || rc=$?
  case "$rc" in
    0) echo "   ok        $1 × $3" ;;
    1) status=1
       echo "   CONFLICT  $1 × $3"
       printf '%s\n' "$out" | awk 'NR > 1 && NF { print "             " $0 }' ;;
    *) status=1
       echo "   ERROR $1 × $3: $(errmsg "git merge-tree exit $rc")" ;;
  esac
}

if [ -n "$against" ]; then
  echo "── pairwise against $against ($n pairs)"
  for ((i = 0; i < n; i++)); do pair "$against_label" "$against_sha" "${labels[i]}" "${refs[i]}"; done
elif [ "$sequential" -eq 0 ] && [ "$n" -ge 2 ]; then
  echo "── pairwise ($n branches, $(( n * (n - 1) / 2 )) pairs)"
  for ((i = 0; i < n; i++)); do
    for ((j = i + 1; j < n; j++)); do pair "${labels[i]}" "${refs[i]}" "${labels[j]}" "${refs[j]}"; done
  done
fi

if [ -n "$check_cmd" ] || [ "$sequential" -eq 1 ]; then
  if [ -n "$against" ]; then
    fold_names=("$against_label") fold_shas=("$against_sha")
  else
    fold_names=("${labels[@]}") fold_shas=("${refs[@]}")
  fi
  echo "── fold onto $def, in order"
  cur=$base
  for idx in "${!fold_shas[@]}"; do
    rc=0
    tree=$(git merge-tree --write-tree "$cur" "${fold_shas[idx]}" 2>"$errf") || rc=$?
    case "$rc" in
      0) ;;
      1) echo "   STOP      ${fold_names[idx]} does not fold onto the ones before it"; exit 1 ;;
      *) echo "   ERROR fold × ${fold_names[idx]}: $(errmsg "git merge-tree exit $rc")"; exit 1 ;;
    esac
    tree=$(printf '%s\n' "$tree" | awk 'NR == 1')
    gx "fold commit" -c user.name=combine-check -c user.email=combine-check@localhost \
      commit-tree "$tree" -p "$cur" -p "${fold_shas[idx]}" -m "combine-check fold: ${fold_names[idx]}"
    cur=$gout
    echo "   folded    ${fold_names[idx]}"
  done
  echo "   fold = $cur"

  if [ -n "$check_cmd" ]; then
    echo "── running on the fold: $check_cmd"
    new_wt fold "$cur"
    run_cmd
    echo "   fold CMD exit = $cmd_rc"
    case "$cmd_rc" in
      0) echo "── the fold passes: $check_cmd (and only that — name what it does not cover)" ;;
      126 | 127)
        echo "── the check cannot run on the fold (exit $cmd_rc)"
        status=1 ;;
      *)
        fold_status=1
        if [ "$baseline" -eq 0 ]; then
          echo "── the fold FAILS: the lanes are individually green but not together"
        else
          # No blame yet: the baseline verdict below decides whose failure it is.
          echo "── the fold FAILS (exit $cmd_rc); running the baseline to see whether main fails too"
          echo "── running on base $def ($base): $check_cmd"
          new_wt base "$base"
          run_cmd
          echo "   base CMD exit = $cmd_rc"
          case "$cmd_rc" in
            0) echo "baseline: $check_cmd passes on base — the combination breaks it" ;;
            126 | 127)  # not runnable on base (e.g. the test files are new): no verdict on main
              echo "baseline: inconclusive — CMD cannot run on base (exit $cmd_rc)" ;;
            *) echo "baseline: $check_cmd also fails on base — the lanes may still have broken it too; compare the failures"
               fold_status=3 ;;
          esac
        fi
        # A pairwise conflict or error is the lanes' fault whatever the baseline says.
        if [ "$status" -ne 1 ]; then status=$fold_status; fi ;;
    esac
  fi
fi

exit "$status"
