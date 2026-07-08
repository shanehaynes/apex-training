#!/usr/bin/env python3
"""
Phase 8 step 2 (EXERCISE_LIBRARY_SPEC.md §4): extract distinct exercises from
Supabase workout_events + schedule.json and emit a human-review file proposing
one exercise_definition per distinct name.

Usage:
  python3 supabase/extract_exercises.py
  # credentials from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars,
  # falling back to .env.local at the repo root.

Output: supabase/exercise_definitions_review.json — edit by hand, then feed to
the apply script. To merge duplicate exercises: delete the duplicate's entry
and add its name variants to the survivor's "aliases".

No third-party dependencies — stdlib only, like seed_events.py.
Read-only against Supabase; safe to re-run (regenerates the review file).
"""

import json
import os
import re
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT_PATH = Path(__file__).parent / "exercise_definitions_review.json"
SCHEDULE_PATH = ROOT / "src" / "data" / "schedule.json"

# Definition-tier fields (spec §2.2). Everything else on an entry is
# prescription or instance data and only informs proposed defaults.
DEFINITION_FIELDS = ("category", "notes", "imageUrl", "muscleGroups")


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


def supabase_events() -> list:
    fallback = load_env_local()
    url = (os.environ.get("SUPABASE_URL") or fallback.get("VITE_SUPABASE_URL", "")).rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY")
        or fallback.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    if not url or not key:
        sys.exit("No Supabase credentials in env or .env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
    req = urllib.request.Request(
        f"{url}/rest/v1/workout_events?select=id,warmup,exercises,cooldown&limit=10000",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def seed_events() -> list:
    return json.loads(SCHEDULE_PATH.read_text())["events"]


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).casefold()


def slugify(name: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", name.casefold())).strip("-")


def most_common(values):
    """Most frequent non-empty value (lists compared by content), or None."""
    counted = Counter(freeze(v) for v in values if v not in (None, "", []))
    if not counted:
        return None
    top = counted.most_common(1)[0][0]
    return json.loads(top) if isinstance(top, str) and top[:1] in "[{" else top


UNILATERAL_RE = re.compile(r"\beach\s+(side|leg|arm)\b|\bper\s+(side|leg|arm)\b", re.I)


def collect(events, source, groups):
    for e in events:
        for section in ("warmup", "exercises", "cooldown"):
            for entry in e.get(section) or []:
                g = groups.setdefault(norm(entry["name"]), {"entries": [], "sources": Counter()})
                g["entries"].append(entry)
                g["sources"][source] += 1


def freeze(value):
    """Hashable form of a JSON value, for variant counting."""
    return json.dumps(value, sort_keys=True) if isinstance(value, (list, dict)) else value


def divergences(entries, field):
    """Distinct non-empty values of a field with counts, when more than one."""
    counted = Counter(freeze(entry.get(field)) for entry in entries if entry.get(field) not in (None, "", []))
    if len(counted) <= 1:
        return None
    return [{"value": json.loads(v) if isinstance(v, str) and v[:1] in "[{" else v, "count": c}
            for v, c in counted.most_common()]


def propose(entries, sources) -> dict:
    names = [entry["name"].strip() for entry in entries]
    canonical = most_common(names)
    notes = [entry.get("notes") for entry in entries if entry.get("notes")]
    # Longest variant becomes the shared technique notes (spec §8 Q5); the
    # apply script keeps divergent copies as instance notes.
    technique = max(notes, key=len) if notes else None
    prescriptions = Counter(
        freeze({k: entry.get(k) for k in ("sets", "reps", "duration", "weight", "restPeriod")
                if entry.get(k) is not None})
        for entry in entries
    )
    top_rx = json.loads(prescriptions.most_common(1)[0][0]) if prescriptions else {}
    flags = {f: d for f in DEFINITION_FIELDS if (d := divergences(entries, f))}

    return {
        "id": slugify(canonical),
        "canonical_name": canonical,
        "aliases": sorted({n for n in names if n != canonical}),
        "category": most_common(entry.get("category") for entry in entries) or "strength",
        "muscle_groups": most_common(entry.get("muscleGroups") for entry in entries) or [],
        "equipment": [],
        "image_url": most_common(entry.get("imageUrl") for entry in entries),
        "technique_notes": technique,
        "is_unilateral": any(
            UNILATERAL_RE.search(str(entry.get(k) or "")) for entry in entries for k in ("reps", "duration", "notes")
        ),
        "default_sets": top_rx.get("sets"),
        "default_reps": top_rx.get("reps"),
        "default_duration": top_rx.get("duration"),
        "default_weight": top_rx.get("weight"),
        "default_rest": top_rx.get("restPeriod"),
        "review": {
            "occurrences": len(entries),
            "by_source": dict(sources),
            "divergences": flags,
            "prescription_variants": [
                {"value": json.loads(v), "count": c} for v, c in prescriptions.most_common(3)
            ],
        },
    }


def near_duplicates(names):
    pairs = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ratio = SequenceMatcher(None, norm(a), norm(b)).ratio()
            if ratio >= 0.75:
                pairs.append({"a": a, "b": b, "similarity": round(ratio, 2)})
    return sorted(pairs, key=lambda p: -p["similarity"])


def main():
    db_events = supabase_events()
    fs_events = seed_events()

    groups = {}
    collect(db_events, "supabase", groups)
    collect(fs_events, "seed", groups)

    defs = sorted(
        (propose(g["entries"], g["sources"]) for g in groups.values()),
        key=lambda d: -d["review"]["occurrences"],
    )
    review = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {"supabase_events": len(db_events), "seed_events": len(fs_events)},
        "instructions": (
            "Review each definition; to merge duplicates, delete one entry and add its "
            "canonical_name + aliases to the survivor's aliases. The apply script ignores "
            "the 'review' blocks."
        ),
        "near_duplicate_suggestions": near_duplicates([d["canonical_name"] for d in defs]),
        "definitions": defs,
    }
    OUT_PATH.write_text(json.dumps(review, indent=2, ensure_ascii=False) + "\n")

    flagged = [d for d in defs if d["review"]["divergences"]]
    print(f"{len(defs)} proposed definitions from {len(db_events)} Supabase + {len(fs_events)} seed events")
    print(f"  → {OUT_PATH.relative_to(ROOT)}")
    if flagged:
        print(f"\n{len(flagged)} definitions have divergent definition-tier fields (need review):")
        for d in flagged:
            print(f"  • {d['canonical_name']}: {', '.join(d['review']['divergences'])}")
    if review["near_duplicate_suggestions"]:
        print(f"\n{len(review['near_duplicate_suggestions'])} possible duplicate pairs (merge suggestions only):")
        for p in review["near_duplicate_suggestions"][:15]:
            print(f"  • {p['a']}  ~  {p['b']}  ({p['similarity']})")


if __name__ == "__main__":
    main()
