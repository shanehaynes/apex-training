import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { useCalendar } from '../../context/calendar';
import { useTemplateCopy } from '../../hooks/useTemplateCopy';
import {
  useOnboardingProgress, useLocalSetupProgress, useSkipSetupRow, useUnskipSetupRow,
} from '../../hooks/useOnboardingProgress';
import { CHECKLIST_ITEMS, EXTRA_NOTES } from '../../lib/onboarding/content';

// Two surfaces over the same setup state:
//
//   GettingStarted — the full checklist, a ProfileView section. Resolving the
//     COROS and connector rows costs a request each, which is fine on a screen
//     the user opened deliberately.
//   SetupNudge — the slim card over the calendar. Reads only signals already
//     in memory (profile + key status) and deliberately avoids
//     useOnboardingActions, whose useProviderSync would add a request to every
//     single app load.

export default function GettingStarted() {
  const { rows, applies, activeCount, doneCount, allDone, run, isBusy } = useOnboardingProgress();
  const skip = useSkipSetupRow();
  const unskip = useUnskipSetupRow();

  // Skipped rows stay listed, last, so a skip can always be taken back here.
  if (!applies || rows.length === 0) return null;

  return (
    <section className="profile-section">
      <h3 className="profile-section__title">
        Getting started
        {activeCount > 0 && <span className="setup__score">{doneCount}/{activeCount}</span>}
      </h3>

      {allDone && (
        <p className="profile-hint">Everything is set up. The list stays here for you to look back on.</p>
      )}

      <ul className="setup__list">
        {rows.map(row => (
          <li
            key={row.id}
            className={`setup__row${row.done ? ' setup__row--done' : ''}${row.skipped ? ' setup__row--skipped' : ''}`}
          >
            <span className="setup__mark" aria-hidden="true">
              {row.done && <Check size={12} strokeWidth={3} />}
            </span>
            <div className="setup__main">
              <span className="setup__label">{row.label}</span>
              <span className="setup__hint">{row.skipped ? 'Skipped.' : row.hint}</span>
            </div>
            {row.skipped && (
              <button className="setup__action" onClick={() => unskip(row.id)} aria-label={`Undo skip: ${row.label}`}>
                Undo
              </button>
            )}
            {!row.done && !row.skipped && (
              <div className="setup__buttons">
                <button
                  className="setup__action"
                  onClick={() => run(row.action.kind)}
                  disabled={isBusy(row.action.kind)}
                >
                  {row.action.label}
                </button>
                <button className="setup__skip" onClick={() => skip(row.id)}>Skip</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <ul className="setup__notes">
        {EXTRA_NOTES.map(note => <li key={note}>{note}</li>)}
      </ul>
    </section>
  );
}

/** Ids the nudge covers — the three the browser already knows without asking. */
const NUDGE_IDS = ['template', 'key', 'goal'] as const;

export function SetupNudge() {
  const { done, skipped, applies, allDone } = useLocalSetupProgress();
  const { dispatch } = useCalendar();
  const { copyTemplate, isCopying } = useTemplateCopy();
  const [hidden, setHidden] = useState(false);

  if (!applies || allDone || hidden) return null;

  const items = NUDGE_IDS.filter(id => !skipped(id)).map(id => ({
    ...CHECKLIST_ITEMS.find(i => i.id === id)!,
    done: done[id],
  }));

  return (
    <div className="setup-nudge" role="status">
      <div className="setup-nudge__head">
        <strong className="setup-nudge__title">Finish setting up</strong>
        <span className="setup-nudge__score">
          {items.filter(i => i.done).length}/{items.length}
        </span>
        {/* Session-only: the full checklist lives in Profile, so nothing is
            lost by closing this, and there is no flag to spend. */}
        <button className="setup-nudge__dismiss" onClick={() => setHidden(true)} aria-label="Dismiss">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <ul className="setup-nudge__list">
        {items.map(item => (
          <li key={item.id} className={`setup-nudge__row${item.done ? ' setup-nudge__row--done' : ''}`}>
            <span className="setup__mark" aria-hidden="true">
              {item.done && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="setup-nudge__label">{item.label}</span>
            {!item.done && (
              <button
                className="setup__action"
                onClick={() => (item.id === 'template' ? copyTemplate() : dispatch({ type: 'OPEN_PROFILE' }))}
                disabled={item.id === 'template' && isCopying}
              >
                {item.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
