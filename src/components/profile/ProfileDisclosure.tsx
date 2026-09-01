import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

// Collapsible profile section. Everything on this screen that is set once and
// then left alone (API key, connector tokens, COROS, password, the activity
// log) lives behind one of these, so the sections a user actually revisits are
// not buried under them.
//
// The header carries a status word — "Saved", "Connected", "3 tokens" — so
// collapsing hides the controls, never the state.

interface Props {
  title: string;
  /** Short state summary shown on the header, collapsed or not. */
  status?: string;
  /**
   * Opens the fold on mount. Reactive on purpose: callers derive it from data
   * that arrives after the first render (`hasKey`, COROS status), and a
   * section the user has something to fix in should be open when they get
   * there. A manual toggle wins from then on.
   */
  defaultOpen?: boolean;
  /** Header control that stays reachable while collapsed — e.g. the connector guide's help icon. */
  action?: React.ReactNode;
  /** Small image on the header, for state a word cannot carry — the chosen avatar. */
  thumb?: React.ReactNode;
  children: React.ReactNode;
}

export default function ProfileDisclosure({ title, status, defaultOpen = false, action, thumb, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [toggled, setToggled] = useState(false);

  useEffect(() => {
    if (!toggled && defaultOpen) setOpen(true);
  }, [defaultOpen, toggled]);

  return (
    <section className={`profile-section profile-fold${open ? ' profile-fold--open' : ''}`}>
      <div className="profile-fold__head">
        <button
          type="button"
          className="profile-fold__toggle"
          aria-expanded={open}
          onClick={() => { setOpen(!open); setToggled(true); }}
        >
          <ChevronRight size={14} strokeWidth={2} className="profile-fold__chevron" />
          <span className="profile-section__title">{title}</span>
          {status && <span className="profile-fold__status">{status}</span>}
          {thumb && <span className="profile-fold__thumb">{thumb}</span>}
        </button>
        {action}
      </div>
      {open && <div className="profile-fold__body">{children}</div>}
    </section>
  );
}
