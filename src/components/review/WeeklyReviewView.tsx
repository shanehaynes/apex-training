import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, KeyRound, RefreshCw, X } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { useMeals } from '../../context/meals';
import { useAuth } from '../../context/auth';
import { useModalChrome } from '../../hooks/useModalChrome';
import { now } from '../../lib/clock';
import { addCoachMemory, ApiError, generateWeeklyReview, runCoachTool } from '../../lib/api';
import { findCoachTool } from '../../lib/coach/tools';
import { previewForTool } from '../../lib/coach/preview';
import { resolveCoachModel } from '../../lib/coach/models';
import {
  isoWeekOf, isWeeklyReviewResponse, shiftWeek, weekLabel,
  type WeekWindow, type WeeklyReviewResponse,
} from '../../lib/review/weekly';
import {
  DoctrineSection, MemoryProposalsSection, NextWeekSection, PhysiologySection, PlanVsDoneSection,
  type AcceptState, type NextWeekCard,
} from './WeeklyReviewSections';
import '../sidebar/confirm-preview.css';
import './weekly-review.css';

// The weekly review overlay (lane D03): the library-view shell, one
// document per open. Opening generates the review for the current ISO week
// on the athlete's own key; the arrows move a week either way and
// regenerate; Regenerate asks again for the same week. Nothing is stored,
// so every open is a fresh request — the header says which model wrote it.
//
// Accepting a next-week item POSTs the exact tool input to /api/coach-tool,
// the executor behind the chat's Confirm, and refreshes completion state the
// way the sidebar does; Realtime reconciles the schedule itself. Accepting a
// memory proposal adds a confirmed, user-sourced fact through the notebook's
// helper. Each card greys out once its click has landed; a failure leaves it
// clickable (the API layer already toasted).

/** One card's accept state, replaced in place; the others keep theirs. */
function setAt(setter: Dispatch<SetStateAction<AcceptState[]>>, index: number, state: AcceptState): void {
  setter(prev => { const next = [...prev]; next[index] = state; return next; });
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; response: WeeklyReviewResponse }
  | { kind: 'no-key' }
  | { kind: 'error'; message: string };

export default function WeeklyReviewView() {
  const { dispatch } = useCalendar();
  const { events, definitions, refreshCompletions } = useSchedule();
  const { meals } = useMeals();
  const { anthropicKey, profile } = useAuth();

  const close = useCallback(() => dispatch({ type: 'CLOSE_WEEKLY_REVIEW' }), [dispatch]);
  useModalChrome(close);

  // The calendar day the review is asked for: read once per mount, like the
  // sidebar, so the e2e fake clock is what the server hears.
  const today = useMemo(() => format(now(), 'yyyy-MM-dd'), []);
  const [week, setWeek] = useState<WeekWindow>(() => isoWeekOf(today));
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [memoryStates, setMemoryStates] = useState<AcceptState[]>([]);
  const [nextWeekStates, setNextWeekStates] = useState<AcceptState[]>([]);

  // A known-missing key blocks the request with the setup prompt; unknown
  // (still loading, offline) lets the server's 402 decide.
  const needsKey = anthropicKey?.hasKey === false;
  const badge = useMemo(() => resolveCoachModel(profile?.coach_model).badge, [profile?.coach_model]);

  // Only the latest request may land: moving weeks quickly must not let an
  // earlier week's document overwrite the one for the week on screen.
  const requestSeq = useRef(0);
  const generate = useCallback(async (target: WeekWindow) => {
    const seq = ++requestSeq.current;
    setStatus({ kind: 'loading' });
    setMemoryStates([]);
    setNextWeekStates([]);
    try {
      const response = await generateWeeklyReview(today, target.start);
      if (seq !== requestSeq.current) return;
      if (!isWeeklyReviewResponse(response)) {
        setStatus({ kind: 'error', message: 'The server answered with something that is not a review document.' });
        return;
      }
      setStatus({ kind: 'ready', response });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err instanceof ApiError && err.status === 402) {
        setStatus({ kind: 'no-key' });
        return;
      }
      const detail = err instanceof ApiError && err.status === 422 ? err.message : '';
      setStatus({ kind: 'error', message: detail || 'The review could not be generated. Try again in a moment.' });
    }
  }, [today]);

  // One request per week shown: StrictMode mounts twice in dev and the key
  // status can settle after mount, and neither may spend the athlete's money
  // twice. Regenerate bypasses this on purpose — that click is a new ask.
  const requestedWeek = useRef<string | null>(null);
  useEffect(() => {
    if (needsKey) {
      requestedWeek.current = null;
      setStatus({ kind: 'no-key' });
      return;
    }
    if (requestedWeek.current === week.start) return;
    requestedWeek.current = week.start;
    void generate(week);
  }, [generate, week, needsKey]);

  const ctx = useMemo(() => ({ definitions, events, meals }), [definitions, events, meals]);

  const document = status.kind === 'ready' ? status.response.document : null;

  // The label and preview are resolved against live state the way the
  // confirm card resolves them, so a card names what will actually change.
  const nextWeekCards = useMemo<NextWeekCard[]>(
    () => (document?.nextWeek ?? []).map(item => ({
      item,
      label: findCoachTool(item.tool)?.displayLabel(item.input, ctx) ?? `${item.tool}`,
      preview: previewForTool(item.tool, item.input, ctx),
    })),
    [document, ctx],
  );

  const acceptNextWeek = useCallback(async (index: number) => {
    const item = document?.nextWeek[index];
    if (!item || nextWeekStates[index] === 'busy' || nextWeekStates[index] === 'done') return;
    setAt(setNextWeekStates, index, 'busy');
    try {
      await runCoachTool(item.tool, item.input, today);
      setAt(setNextWeekStates, index, 'done');
      refreshCompletions().catch(() => {});
    } catch {
      setAt(setNextWeekStates, index, 'error');
    }
  }, [document, nextWeekStates, today, refreshCompletions]);

  const rememberProposal = useCallback(async (index: number) => {
    const proposal = document?.memoryProposals[index];
    if (!proposal || memoryStates[index] === 'busy' || memoryStates[index] === 'done') return;
    setAt(setMemoryStates, index, 'busy');
    try {
      await addCoachMemory(proposal.kind, proposal.content);
      setAt(setMemoryStates, index, 'done');
    } catch {
      setAt(setMemoryStates, index, 'error');
    }
  }, [document, memoryStates]);

  const loading = status.kind === 'loading';

  return (
    <div className="library-view weekly-review" data-testid="weekly-review-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h2 className="library-header__title">Weekly review</h2>
          <span className="library-header__count" data-testid="weekly-review-model">
            {status.kind === 'ready' ? status.response.model.badge : badge}
          </span>
        </div>
        <div className="library-header__actions">
          <button
            className="library-edit-btn"
            onClick={() => setWeek(w => shiftWeek(w, -1))}
            disabled={loading}
            aria-label="Previous week"
            title="Previous week"
          >
            <ChevronLeft size={14} strokeWidth={1.5} />
          </button>
          <span className="weekly-review__week" data-testid="weekly-review-week">{weekLabel(week)}</span>
          <button
            className="library-edit-btn"
            onClick={() => setWeek(w => shiftWeek(w, 1))}
            disabled={loading || week.start >= isoWeekOf(today).start}
            aria-label="Next week"
            title="Next week"
          >
            <ChevronRight size={14} strokeWidth={1.5} />
          </button>
          <button
            className="library-edit-btn"
            data-testid="weekly-review-regenerate"
            onClick={() => void generate(week)}
            disabled={loading || needsKey}
            title="Ask the coach again for this week"
          >
            <RefreshCw size={14} strokeWidth={1.5} /> Regenerate
          </button>
          <button className="library-close" onClick={close} aria-label="Close weekly review">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="weekly-review__body">
        {status.kind === 'loading' && (
          <div className="weekly-review__state" aria-busy="true" data-testid="weekly-review-loading">
            <span className="chat-typing"><span /><span /><span /></span>
            <p className="weekly-review__muted">Reading the week on {badge}…</p>
          </div>
        )}

        {status.kind === 'no-key' && (
          <div className="weekly-review__state" data-testid="weekly-review-no-key">
            <p className="weekly-review__text">
              The weekly review runs on your own Anthropic key. Add one in Profile to turn it on.
            </p>
            <button className="chat-key-setup-btn" onClick={() => dispatch({ type: 'OPEN_PROFILE' })}>
              <KeyRound size={13} /> Add key
            </button>
          </div>
        )}

        {status.kind === 'error' && (
          <div className="weekly-review__state" role="alert" data-testid="weekly-review-error">
            <p className="weekly-review__text">{status.message}</p>
          </div>
        )}

        {status.kind === 'ready' && document && (
          <article className="weekly-review__document" data-testid="weekly-review-document">
            <h2 className="weekly-review__headline" data-testid="weekly-review-headline">{document.headline}</h2>
            {status.response.warnings.length > 0 && (
              <ul className="weekly-review__warnings" aria-label="Sections the server dropped">
                {status.response.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <PlanVsDoneSection plan={document.planVsDone} />
            <PhysiologySection physiology={document.physiology} />
            <DoctrineSection doctrine={document.doctrine} />
            <MemoryProposalsSection proposals={document.memoryProposals} states={memoryStates} onRemember={rememberProposal} />
            <NextWeekSection cards={nextWeekCards} states={nextWeekStates} onAccept={acceptNextWeek} />
          </article>
        )}
      </div>
    </div>
  );
}
