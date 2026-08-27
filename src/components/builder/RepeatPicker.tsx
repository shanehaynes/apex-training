import { Repeat } from 'lucide-react';
import {
  REPEAT_DAY_LABELS, REPEAT_DAY_ORDER, REPEAT_OFF, type DraftRepeat,
} from '../../lib/builder/repeat';
import type { Weekday } from '../../lib/recurrence/index.js';

interface Props {
  repeat: DraftRepeat;
  onChange: (repeat: DraftRepeat) => void;
  /** Editing an existing series: repeating can be reshaped but not switched
   *  off here — ending a series is an Ends date, or delete in the modal. */
  lockOff: boolean;
  accentColor: string;
}

/** Day chips + every-N-weeks + an end date — the builder's repeat schedule. */
export default function RepeatPicker({ repeat, onChange, lockOff, accentColor }: Props) {
  if (repeat.custom) {
    return (
      <div className="builder-repeat composer-field--wide">
        <span className="library-field__label"><Repeat size={12} strokeWidth={1.5} /> Repeat</span>
        <p className="builder-repeat__custom">
          This series uses a repeat pattern the picker can't edit ({repeat.custom}). It is kept as is.
        </p>
      </div>
    );
  }

  const toggleDay = (day: Weekday) => {
    const days = repeat.days.includes(day)
      ? repeat.days.filter(d => d !== day)
      : [...repeat.days, day];
    onChange({ ...repeat, days });
  };

  return (
    <div className="builder-repeat composer-field--wide">
      <div className="builder-repeat__head">
        <span className="library-field__label"><Repeat size={12} strokeWidth={1.5} /> Repeat</span>
        {!lockOff && (
          <button
            className={`builder-repeat__switch${repeat.enabled ? ' builder-repeat__switch--on' : ''}`}
            style={repeat.enabled ? { borderColor: accentColor, color: accentColor } : undefined}
            aria-pressed={repeat.enabled}
            onClick={() => onChange(repeat.enabled ? REPEAT_OFF : { ...repeat, enabled: true })}
          >
            {repeat.enabled ? 'On' : 'Off'}
          </button>
        )}
      </div>

      {repeat.enabled && (
        <div className="builder-repeat__body">
          <div className="builder-repeat__days" role="group" aria-label="Repeat on days">
            {REPEAT_DAY_ORDER.map(day => {
              const active = repeat.days.includes(day);
              return (
                <button
                  key={day}
                  className={`builder-repeat__day${active ? ' builder-repeat__day--active' : ''}`}
                  style={active ? { borderColor: accentColor, color: accentColor } : undefined}
                  aria-pressed={active}
                  aria-label={`Repeat on ${day}`}
                  onClick={() => toggleDay(day)}
                >
                  {REPEAT_DAY_LABELS[day]}
                </button>
              );
            })}
          </div>
          <label className="builder-repeat__interval">
            every
            <input
              inputMode="numeric"
              className="library-field__input builder-repeat__interval-input"
              value={repeat.interval}
              onChange={e => onChange({ ...repeat, interval: e.target.value })}
            />
            week{parseInt(repeat.interval, 10) === 1 ? '' : 's'}
          </label>
          <div className="builder-repeat__ends">
            <span>Ends</span>
            <button
              className={`builder-repeat__end-opt${!repeat.until ? ' builder-repeat__end-opt--active' : ''}`}
              onClick={() => onChange({ ...repeat, until: '' })}
            >
              Never
            </button>
            <input
              type="date"
              className="library-field__input builder-repeat__until"
              aria-label="Repeat until"
              value={repeat.until}
              onChange={e => onChange({ ...repeat, until: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
