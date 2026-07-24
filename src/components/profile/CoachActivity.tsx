import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { authHeaders } from '../../lib/api';

// Read-only view of the mutation audit logs (/api/mutations-log) — makes
// coach-driven schedule changes visible so unexpected activity is caught
// by a glance, not a database query.

interface ActivityEntry {
  source: 'event' | 'definition';
  operation: string;
  title: string;
  event_date: string | null;
  triggered_by: string;
  logged_at: string;
}

const OPERATION_LABELS: Record<string, string> = {
  create:          'Created',
  update:          'Updated',
  delete:          'Deleted',
  delete_instance: 'Skipped occurrence of',
  update_instance: 'Rescheduled occurrence of',
  archive:         'Archived',
  unarchive:       'Unarchived',
};

export default function CoachActivity() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Raw fetch, not getJson: a failure here (e.g. offline mode, where
    // /api/* is not served) should hide the section, not toast.
    (async () => {
      try {
        const res = await fetch('/api/mutations-log', { headers: await authHeaders() });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { entries?: ActivityEntry[] };
        setEntries(data.entries ?? []);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (failed) return null;

  return (
    <section className="profile-section">
      <h3 className="profile-section__title">Coach activity</h3>
      <p className="profile-hint">
        Every schedule and library change, and whether you or the AI coach
        made it. Recent first.
      </p>
      {entries === null ? (
        <p className="profile-msg">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="profile-msg">No changes logged yet.</p>
      ) : (
        <ul className="coach-activity">
          {entries.map((e, i) => (
            <li key={i} className="coach-activity__row">
              <span className={`coach-activity__badge coach-activity__badge--${e.triggered_by === 'user' ? 'user' : 'ai'}`}>
                {e.triggered_by === 'user' ? 'You' : 'Coach'}
              </span>
              <span className="coach-activity__text">
                {OPERATION_LABELS[e.operation] ?? e.operation}{' '}
                <strong>{e.title}</strong>
                {e.source === 'definition' ? ' (library)' : ''}
                {e.event_date ? ` · ${e.event_date}` : ''}
              </span>
              <span className="coach-activity__time">
                {format(parseISO(e.logged_at), 'MMM d, HH:mm')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
