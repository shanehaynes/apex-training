#!/usr/bin/env bash
# Vendor the parallel-agents skill into a project as a pinned, stamped copy.
#
#   vendor-parallel-agents.sh <project-dir> [--from <parallel-agents-dir>] [--force]
#
# Copies <source>/ to <project>/.claude/skills/parallel-agents/ and writes a
# VENDORED stamp (source path, UTC time, content hash). check-vendored.sh
# compares against that stamp later. Without --from, the source is found by
# searching the places skills are installed; if there are several distinct
# versions it stops and lists them rather than guessing.
#
# Why a copy at all: hooks and scripts run from a path inside the project, and
# the user's installed skills are absent in CI, other machines and fresh
# containers. What makes this copy safe is the stamp — drift is detectable.
#
# Portable bash 3.2+.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=_hash.sh
. "$here/_hash.sh"

die() { echo "vendor-parallel-agents: $*" >&2; exit 1; }

project="" from="" force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=${2:?--from needs a directory}; shift 2 ;;
    --force) force=1; shift ;;
    -*) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
    *) [ -z "$project" ] || die "one project dir only"; project=$1; shift ;;
  esac
done
[ -n "$project" ] || { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
project=$(cd "$project" && pwd -P)
dest="$project/.claude/skills/parallel-agents"

if [ -z "$from" ]; then
  from=$(find_installed_parallel_agents "$dest") || exit 1
fi
[ -f "$from/SKILL.md" ] || die "no SKILL.md in $from"
grep -q '^name: parallel-agents' "$from/SKILL.md" || die "$from/SKILL.md is not the parallel-agents skill"
from=$(cd "$from" && pwd -P)
[ "$from" != "$dest" ] || die "source and destination are the same directory"

if [ -e "$dest" ] && [ "$force" -eq 0 ]; then
  if [ -f "$dest/VENDORED" ] && [ "$(content_hash "$dest")" != "$(stamp_field "$dest/VENDORED" hash)" ]; then
    die "$dest has local edits since it was vendored; move them to parallel-agents' source first, or pass --force to discard them"
  fi
fi

rm -rf "$dest"
mkdir -p "$dest"
(cd "$from" && tar cf - --exclude VENDORED .) | (cd "$dest" && tar xf -)
chmod +x "$dest"/scripts/*.sh 2>/dev/null || true

hash=$(content_hash "$dest")
cat > "$dest/VENDORED" <<EOF
# Pinned copy of the parallel-agents skill. Do not edit here: change the skill
# at its source, then re-vendor. check-vendored.sh (new-dev-project skill)
# reports drift against the installed skill and local edits against this stamp.
source: $from
vendored: $(date -u +%FT%TZ)
hash: $hash
EOF

echo "── vendored parallel-agents → ${dest#$project/}"
echo "   source: $from"
echo "   hash:   $hash"
