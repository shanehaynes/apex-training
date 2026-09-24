#!/usr/bin/env bash
# Is a project's vendored parallel-agents still the skill it claims to be?
#
#   check-vendored.sh <project-dir> [--from <installed-parallel-agents-dir>]
#
# Two questions, answered separately because they have different fixes:
#   local  — has anyone edited the vendored copy since it was stamped?
#            (fix: move the edit to parallel-agents' source, then re-vendor)
#   source — does the installed skill differ from the vendored copy?
#            (fix: read what changed, then re-vendor with vendor-parallel-agents.sh)
#
# Exit: 0 in sync · 1 drift found · 2 not vendored / no stamp · 64 usage.
# "source" is skipped (not failed) when no installed skill can be found, e.g.
# in CI — there the local check is the one that matters.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=_hash.sh
. "$here/_hash.sh"

project="" from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=${2:?--from needs a directory}; shift 2 ;;
    -*) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
    *) project=$1; shift ;;
  esac
done
[ -n "$project" ] || { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
dest="$(cd "$project" && pwd -P)/.claude/skills/parallel-agents"
stamp="$dest/VENDORED"

[ -f "$stamp" ] || { echo "not vendored: no $stamp (run vendor-parallel-agents.sh)"; exit 2; }

status=0
now=$(content_hash "$dest")
if [ "$now" = "$(stamp_field "$stamp" hash)" ]; then
  echo "local   ok       vendored copy matches its stamp"
else
  echo "local   EDITED   vendored copy was changed after vendoring — move the change to the skill's source"
  status=1
fi

if [ -z "$from" ]; then from=$(find_installed_parallel_agents "$dest" 2>/dev/null || true); fi
if [ -z "$from" ]; then
  echo "source  skipped  no installed parallel-agents skill found (normal in CI)"
elif [ "$(content_hash "$from")" = "$(stamp_field "$stamp" hash)" ]; then
  echo "source  ok       installed skill matches ($from)"
else
  echo "source  DRIFTED  installed skill differs from the vendored copy"
  echo "                 diff -r \"$dest\" \"$from\"   then re-vendor if the change is wanted"
  status=1
fi
exit "$status"
