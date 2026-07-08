#!/usr/bin/env python3
"""
Phase 8 step 4 (EXERCISE_LIBRARY_SPEC.md §4): apply the reviewed extraction.

Consumes supabase/exercise_definitions_review.json (human-reviewed output of
extract_exercises.py) and:
  1. upserts one exercise_definitions row per definition ("review" blocks ignored)
  2. rewrites every workout_events row's warmup/exercises/cooldown entries:
     - stamps definitionId on entries whose name matches a canonical name or alias
     - clears entry notes that exactly match the hoisted technique_notes
       (divergent notes are kept — they are instance-specific)
  3. applies the same rewrite to src/data/schedule.json (the offline fallback)

Usage:
  python3 supabase/apply_exercise_definitions.py
  # credentials from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars,
  # falling back to .env.local at the repo root.

Idempotent — re-running stamps the same ids and leaves cleared notes cleared.
Non-destructive — entries keep name/category snapshots; unmatched entries are
left untouched and reported.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
REVIEW_PATH = Path(__file__).parent / "exercise_definitions_review.json"
SCHEDULE_PATH = ROOT / "src" / "data" / "schedule.json"

SECTIONS = ("warmup", "exercises", "cooldown")


def load_env_local() -> dict:
    env = {}
    path = ROOT / ".env.local"
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def credentials() -> tuple:
    fallback = load_env_local()
    url = (os.environ.get("SUPABASE_URL") or fallback.get("VITE_SUPABASE_URL", "")).rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY")
        or fallback.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    if not url or not key:
        sys.exit("No Supabase credentials in env or .env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
    return url, key


def request(url: str, key: str, path: str, method: str = "GET", body=None, prefer: str | None = None):
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} → HTTP {e.code}: {e.read().decode()}")


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).casefold()


def definition_row(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "review"}


def rewrite_event(event: dict, index: dict) -> tuple[dict, dict] | None:
    """Rewritten section arrays if anything changed, plus per-event stats."""
    changed = False
    stats = {"stamped": 0, "notes_cleared": 0, "unmatched": []}
    new_sections = {}
    for section in SECTIONS:
        entries = event.get(section) or []
        new_entries = []
        for entry in entries:
            d = index.get(norm(entry["name"]))
            if d is None:
                stats["unmatched"].append(entry["name"])
                new_entries.append(entry)
                continue
            e = dict(entry)
            if e.get("definitionId") != d["id"]:
                e["definitionId"] = d["id"]
                stats["stamped"] += 1
            if e.get("notes") and d["technique_notes"] and e["notes"].strip() == d["technique_notes"].strip():
                del e["notes"]
                stats["notes_cleared"] += 1
            if e != entry:
                changed = True
            new_entries.append(e)
        new_sections[section] = new_entries
    return (new_sections, stats) if changed else (None, stats)


def main():
    review = json.loads(REVIEW_PATH.read_text())
    definitions = review["definitions"]
    index = {}
    for d in definitions:
        index[norm(d["canonical_name"])] = d
        for alias in d["aliases"]:
            index[norm(alias)] = d

    url, key = credentials()

    print(f"Upserting {len(definitions)} exercise definitions …")
    request(url, key, "exercise_definitions", "POST",
            [definition_row(d) for d in definitions], prefer="resolution=merge-duplicates")

    events = request(url, key, f"workout_events?select=id,{','.join(SECTIONS)}&limit=10000")
    totals = {"stamped": 0, "notes_cleared": 0, "events_patched": 0}
    unmatched = set()
    for event in events:
        new_sections, stats = rewrite_event(event, index)
        totals["stamped"] += stats["stamped"]
        totals["notes_cleared"] += stats["notes_cleared"]
        unmatched.update(stats["unmatched"])
        if new_sections:
            request(url, key, f"workout_events?id=eq.{urllib.parse.quote(event['id'])}", "PATCH", new_sections)
            totals["events_patched"] += 1
    print(f"Supabase: {totals['events_patched']}/{len(events)} events patched, "
          f"{totals['stamped']} entries stamped, {totals['notes_cleared']} notes cleared")

    schedule = json.loads(SCHEDULE_PATH.read_text())
    seed_stats = {"stamped": 0, "notes_cleared": 0, "events_patched": 0}
    for event in schedule["events"]:
        new_sections, stats = rewrite_event(event, index)
        seed_stats["stamped"] += stats["stamped"]
        seed_stats["notes_cleared"] += stats["notes_cleared"]
        unmatched.update(stats["unmatched"])
        if new_sections:
            event.update(new_sections)
            seed_stats["events_patched"] += 1
    # ensure_ascii matches the file's existing escaped-unicode style, keeping the diff minimal.
    SCHEDULE_PATH.write_text(json.dumps(schedule, indent=2, ensure_ascii=True) + "\n")
    print(f"schedule.json: {seed_stats['events_patched']} events patched, "
          f"{seed_stats['stamped']} entries stamped, {seed_stats['notes_cleared']} notes cleared")

    if unmatched:
        print(f"\nWARNING — {len(unmatched)} exercise names matched no definition (left untouched):")
        for name in sorted(unmatched):
            print(f"  • {name}")


if __name__ == "__main__":
    main()
