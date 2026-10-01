import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { NOTEBOOK_TAB_LABELS, NOTEBOOK_TABS, type NotebookTab } from '../../lib/coach/notebook';
import MemoryTab from './MemoryTab';
import ContractTab from './ContractTab';
import DoctrineTab from './DoctrineTab';
import './notebook.css';

// The coach's notebook (lane D02): one full-screen page, phone first, where
// the athlete sees and controls everything the coach carries between
// conversations. Three tabs — Memory (the confirmed facts and the proposals
// waiting on a click), Contract (the coaching contract and the overnight
// reflections that propose edits to it), Doctrine (the method, read-only).
// Same overlay shell as the library and the profile (fixed inset-0, Escape
// closes); it opens from the profile's Coach section and sits over it, so
// closing returns there.
//
// Decision D-C02: every self-improvement the coach makes is a proposal the
// athlete approves. This is where they approve it.

export default function NotebookView() {
  const { dispatch } = useCalendar();
  const [tab, setTab] = useState<NotebookTab>('memory');
  const close = () => dispatch({ type: 'CLOSE_NOTEBOOK' });

  // Not useModalChrome: the profile underneath has its own, listening on
  // document, and two Escape handlers would close both overlays at once —
  // the notebook and the page it opened from. A capture-phase listener on
  // window runs first and stops the event before the profile's sees it, so
  // Escape peels one layer. The profile keeps the body-scroll lock, which is
  // also why this view never touches it (useModalChrome's unlock is
  // last-writer-wins and would free the body under a still-open profile).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dispatch({ type: 'CLOSE_NOTEBOOK' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch]);

  return (
    <div className="library-view notebook" data-testid="notebook">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">Coach notebook</h2>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <NotebookTabs tab={tab} onChange={setTab} />

      <div
        className="notebook-body"
        role="tabpanel"
        id={`notebook-panel-${tab}`}
        aria-labelledby={`notebook-tab-${tab}`}
      >
        {tab === 'memory' && <MemoryTab />}
        {tab === 'contract' && <ContractTab />}
        {tab === 'doctrine' && <DoctrineTab />}
      </div>
    </div>
  );
}

/** The tab strip: three equal buttons, the active one underlined in the accent. */
export function NotebookTabs({ tab, onChange }: { tab: NotebookTab; onChange: (tab: NotebookTab) => void }) {
  return (
    <div className="notebook-tabs" role="tablist" aria-label="Notebook sections">
      {NOTEBOOK_TABS.map(id => (
        <button
          key={id}
          id={`notebook-tab-${id}`}
          type="button"
          role="tab"
          className="notebook-tab"
          aria-selected={tab === id}
          aria-controls={`notebook-panel-${id}`}
          data-testid={`notebook-tab-${id}`}
          onClick={() => onChange(id)}
        >
          {NOTEBOOK_TAB_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
