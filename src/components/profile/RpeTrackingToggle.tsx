import { useState } from 'react';
import { isRpeTrackingEnabled, setRpeTrackingEnabled } from '../../lib/tracking/fields';

/**
 * Profile → Training: whether the tracker's set rows offer an RPE field. A
 * device preference (localStorage, see lib/tracking/fields.ts), so it
 * needs no profile column and reads back on the next paint of the tracker.
 */
export default function RpeTrackingToggle() {
  const [on, setOn] = useState(isRpeTrackingEnabled);
  return (
    <label className="profile-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="checkbox"
        checked={on}
        onChange={e => { setOn(e.target.checked); setRpeTrackingEnabled(e.target.checked); }}
        aria-label="Rate sets by effort in the tracker"
      />
      Rate sets by effort (RPE 1–10) in the tracker. Remembered on this device.
    </label>
  );
}
