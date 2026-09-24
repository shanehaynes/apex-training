# Shared helpers for vendor-parallel-agents.sh and check-vendored.sh. Sourced.

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

# Hash of a skill directory's content: every file except the VENDORED stamp,
# by relative path and bytes, in a locale-independent order. Mode bits are not
# included (git does not keep most of them either).
content_hash() {
  (cd "$1" && find . -type f ! -name VENDORED | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\0' "$f"
    _sha256 < "$f"
  done) | _sha256
}

stamp_field() { sed -n "s/^$2: //p" "$1" | head -1; }

# Every parallel-agents skill installed where Claude Code keeps skills,
# excluding the project's own vendored copy. Prints one directory, or lists the
# candidates and fails when they hold different content.
find_installed_parallel_agents() {
  local exclude=$1 cands="" d h first="" differ=0
  for base in "$HOME/.claude/skills" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"; do
    [ -d "$base" ] || continue
    while IFS= read -r d; do
      d=$(cd "$(dirname "$d")" && pwd -P)
      [ "$d" = "$exclude" ] && continue
      grep -q '^name: parallel-agents' "$d/SKILL.md" 2>/dev/null || continue
      case "$cands" in *"$d"*) continue ;; esac
      cands="$cands$d
"
    done < <(find "$base" -maxdepth 4 -path '*parallel-agents/SKILL.md' 2>/dev/null)
  done
  cands=$(printf '%s' "$cands" | sed '/^$/d')
  if [ -z "$cands" ]; then
    echo "no installed parallel-agents skill found under ~/.claude/skills; pass --from <dir>" >&2
    return 1
  fi
  while IFS= read -r d; do
    h=$(content_hash "$d")
    if [ -z "$first" ]; then first=$h; elif [ "$h" != "$first" ]; then differ=1; fi
  done <<< "$cands"
  if [ "$differ" -eq 1 ]; then
    echo "several different parallel-agents skills are installed; pass --from <dir>:" >&2
    printf '%s\n' "$cands" | sed 's/^/  /' >&2
    return 1
  fi
  printf '%s\n' "$cands" | head -1
}
