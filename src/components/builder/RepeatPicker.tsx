import { Repeat } from 'lucide-react';
import { useTip } from '../../hooks/useTip';
import {
  REPEAT_DAY_LABELS, REPEAT_DAY_ORDER, REPEAT_OFF, repeatFreq, type DraftRepeat, type RepeatFreq,
} from '../../lib/builder/repeat';
import type { Weekday } from '../../lib/recurrence/index.js';
import '../../styles/repeat-picker.css';

interface Props {
  repeat: DraftRepeat;
  onChange: (repeat: DraftRepeat) => void;
  /** Editing an existing series: repeating can be reshaped but not switched
   *  off here — ending a series is an Ends date, or delete in the modal. */
  lockOff: boolean;
  accentColor: string;
}

const FREQS: ReadonlyArray<{ value: RepeatFreq; label: string; unit: string }> = [
  { value: 'WEEKLY', label: 'Weekly', unit: 'week' },
  { value: 'DAILY', label: 'Daily', unit: 'day' },
];

/** Weekly or daily, every N, ending never / on a date / after N times — the
 *  builder's repeat schedule. */
export default function RepeatPicker({ repeat, onChange, lockOff, accentColor }: Props) {
  // Where recurring workouts are born — offered only while the On/Off switch
  // is on screen (not on an existing series, not on a custom pattern).
  useTip('builder-repeat', !lockOff && !repeat.custom);

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

  const freq = repeatFreq(repeat);
  const count = repeat.count ?? '';
  const unit = FREQS.find(f => f.value === freq)!.unit;
  const active = { borderColor: accentColor, color: accentColor };

  const toggleDay = (day: Weekday) => {
    const days = repeat.days.includes(day)
      ? repeat.days.filter(d => d !== day)
      : [...repeat.days, day];
    onChange({ ...repeat, days });
  };

  // Days belong to weekly rules only: a daily rule drops them, so nothing
  // downstream can snap the anchor to a chip the user no longer sees.
  const setFreq = (next: RepeatFreq) =>
    onChange({ ...repeat, freq: next, days: next === 'WEEKLY' ? repeat.days : [] });

  return (
    <div className="builder-repeat composer-field--wide">
      <div className="builder-repeat__head">
        <span className="library-field__label"><Repeat size={12} strokeWidth={1.5} /> Repeat</span>
        {!lockOff && (
          <button
            className={`builder-repeat__switch${repeat.enabled ? ' builder-repeat__switch--on' : ''}`}
            style={repeat.enabled ? active : undefined}
            aria-pressed={repeat.enabled}
            onClick={() => onChange(repeat.enabled ? REPEAT_OFF : { ...repeat, enabled: true })}
          >
            {repeat.enabled ? 'On' : 'Off'}
          </button>
        )}
      </div>

      {repeat.enabled && (
        <div className="builder-repeat__body">
          <div className="builder-repeat__freq" role="group" aria-label="Repeat frequency">
            {FREQS.map(f => (
              <button
                key={f.value}
                className={`builder-repeat__end-opt${freq === f.value ? ' builder-repeat__end-opt--active' : ''}`}
                style={freq === f.value ? active : undefined}
                aria-pressed={freq === f.value}
                onClick={() => setFreq(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {freq === 'WEEKLY' && (
            <div className="builder-repeat__days" role="group" aria-label="Repeat on days">
              {REPEAT_DAY_ORDER.map(day => {
                const on = repeat.days.includes(day);
                return (
                  <button
                    key={day}
                    className={`builder-repeat__day${on ? ' builder-repeat__day--active' : ''}`}
                    style={on ? active : undefined}
                    aria-pressed={on}
                    aria-label={`Repeat on ${day}`}
                    onClick={() => toggleDay(day)}
                  >
                    {REPEAT_DAY_LABELS[day]}
                  </button>
                );
              })}
            </div>
          )}
          <label className="builder-repeat__interval">
            every
            <input
              inputMode="numeric"
              className="library-field__input builder-repeat__interval-input"
              aria-label="Repeat interval"
              value={repeat.interval}
              onChange={e => onChange({ ...repeat, interval: e.target.value })}
            />
            {unit}{parseInt(repeat.interval, 10) === 1 ? '' : 's'}
          </label>
          <div className="builder-repeat__ends">
            <span>Ends</span>
            <button
              className={`builder-repeat__end-opt${!repeat.until && !count ? ' builder-repeat__end-opt--active' : ''}`}
              onClick={() => onChange({ ...repeat, until: '', count: '' })}
            >
              Never
            </button>
            <input
              type="date"
              className="library-field__input builder-repeat__until"
              aria-label="Repeat until"
              value={repeat.until}
              onChange={e => onChange({ ...repeat, until: e.target.value, count: '' })}
            />
            <label className={`builder-repeat__count${count ? ' builder-repeat__count--active' : ''}`}>
              after
              <input
                inputMode="numeric"
                className="library-field__input builder-repeat__count-input"
                aria-label="Repeat count"
                placeholder="N"
                value={count}
                onChange={e => onChange({ ...repeat, count: e.target.value, until: '' })}
              />
              times
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
