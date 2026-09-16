#!/usr/bin/env bash
# The local Supabase project id, and container lookups scoped to it.
#
#   . scripts/lib/project-id.sh     # source it, do not run it
#
# WHY THIS EXISTS
# The Supabase CLI names containers supabase_<service>_<project_id>, and this
# machine runs one Docker daemon for every project on it. An unscoped
# `grep '^supabase_db_'` therefore matches ANY project's database container —
# so `db-reset-local.sh` run from this repo while a different project's stack
# is the one up would truncate that project's tables instead, with no error.
# `head -1` made it worse: with two stacks up it picked whichever Docker
# happened to list first.
#
# Callers must already be at the repo root (each one cds there first), so that
# supabase/config.toml — the file that declares the id — is readable here.

# Print this repo's project_id; non-zero and a message if it cannot be read.
apex_project_id() {
  local id
  id=$(sed -n 's/^project_id[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' \
         supabase/config.toml 2>/dev/null | head -1)
  if [ -z "$id" ]; then
    echo "error: no project_id in supabase/config.toml — refusing to guess which" \
         "project's containers to touch" >&2
    return 1
  fi
  printf '%s' "$id"
}

# Print the running container for one service of THIS project, or nothing.
#
# `grep -x` rather than a prefix match plus `head -1`: an exact whole-line
# match cannot pick up a neighbouring project, and without `head -1` a
# surprise yields nothing rather than the wrong container.
apex_container() {
  local svc=$1 id
  id=$(apex_project_id) || return 1
  docker ps --format '{{.Names}}' 2>/dev/null | grep -x "supabase_${svc}_${id}" || true
}

# Print every container of THIS project that exists but is not running.
#
# A `case` glob, not an awk regex: the id is interpolated literally, so a
# project_id containing a regex metacharacter cannot widen the match.
apex_stopped_containers() {
  local id name state
  id=$(apex_project_id) || return 1
  docker ps -a --format '{{.Names}} {{.State}}' 2>/dev/null \
    | while read -r name state; do
        case "$name" in
          supabase_*_"$id")
            if [ "$state" != running ]; then printf '%s\n' "$name"; fi
            ;;
        esac
      done
}
