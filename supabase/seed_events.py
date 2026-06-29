#!/usr/bin/env python3
"""
Seed workout_events from schedule.json.

Usage:
  SUPABASE_URL=https://xxx.supabase.co \
  SUPABASE_SERVICE_KEY=eyJ... \
  python3 supabase/seed_events.py

No third-party dependencies — uses stdlib urllib only.
Safe to re-run — uses upsert (ON CONFLICT DO UPDATE).

Get the service-role key from:
  Supabase dashboard → Project Settings → API → service_role (secret)
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit(
        "Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.\n"
        "Use the service-role key (not the anon key) — it bypasses RLS.\n\n"
        "Example:\n"
        "  SUPABASE_URL=https://prmlzrkcfvmfapauoxqn.supabase.co \\\n"
        "  SUPABASE_SERVICE_KEY=eyJ... \\\n"
        "  python3 supabase/seed_events.py"
    )

SCHEDULE_PATH = Path(__file__).parent.parent / "src" / "data" / "schedule.json"
schedule = json.loads(SCHEDULE_PATH.read_text())


def map_event(e: dict) -> dict:
    rp = e.get("recurringPattern") or {}
    return {
        "id":                  e["id"],
        "type":                e["type"],
        "title":               e["title"],
        "subtitle":            e.get("subtitle"),
        "date":                e["date"],
        "start_time":          e.get("startTime"),
        "end_time":            e.get("endTime"),
        "estimated_duration":  e["estimatedDuration"],
        "description":         e.get("description", ""),
        "warmup":              e.get("warmup") or [],
        "exercises":           e.get("exercises") or [],
        "cooldown":            e.get("cooldown") or [],
        "difficulty":          e["difficulty"],
        "location":            e.get("location"),
        "cover_image_url":     e.get("coverImageUrl"),
        "tags":                e.get("tags") or [],
        "equipment":           e.get("equipment") or [],
        "is_recurring":        bool(e.get("isRecurring")),
        "recurring_frequency": rp.get("frequency"),
        "recurring_days":      rp.get("daysOfWeek"),
        "recurring_end_date":  rp.get("endDate"),
    }


def post_batch(rows: list) -> None:
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/workout_events",
        data=payload,
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (200, 201):
                body = resp.read().decode()
                sys.exit(f"Unexpected status {resp.status}: {body}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.exit(f"HTTP {e.code}: {body}")


rows = [map_event(e) for e in schedule["events"]]
print(f"Seeding {len(rows)} events into workout_events …")

BATCH = 100
for i in range(0, len(rows), BATCH):
    batch = rows[i : i + BATCH]
    post_batch(batch)
    print(f"  Rows {i + 1}–{min(i + BATCH, len(rows))} ✓")

print(f"\nDone. {len(rows)} events upserted.")
