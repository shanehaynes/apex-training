import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatSidebar from '../ChatSidebar';
import { askCoachDisplay, askCoachPrompt, type AskCoachRequest } from '../../../lib/coach/askContext';

// The "Ask the coach" effect (D-C08), proved without a DOM: react-dom/server
// never runs effects, so `useEffect` is stubbed to run its body during the
// render, and useChat, the contexts and the model picker are stubbed the way
// the notebook tests stub theirs. Each render is a fresh mount, so "waits,
// then sends once idle" is two renders with the pane's state changed between
// them — the same decision the live effect makes when its deps change.

const pane = vi.hoisted(() => ({
  askCoach: null as AskCoachRequest | null,
  dispatch: vi.fn(),
  hasKey: true as boolean | null,
  chat: {
    messages: [] as unknown[],
    isLoading: false,
    streamingContent: '',
    streamingReads: [] as string[],
    pendingAction: null as unknown,
    pendingActionCount: 0,
    sendMessage: vi.fn(async () => {}),
    confirmAction: vi.fn(),
    cancelAction: vi.fn(),
    triggerInitial: vi.fn(),
    newThread: vi.fn(),
    abort: vi.fn(),
  },
}));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (fn: () => void | (() => void)) => { fn(); } };
});
vi.mock('../../../hooks/useChat', () => ({ useChat: () => pane.chat }));
vi.mock('../../../context/calendar', () => ({
  useCalendar: () => ({ state: { askCoach: pane.askCoach }, dispatch: pane.dispatch }),
}));
vi.mock('../../../context/auth', () => ({
  useAuth: () => ({ anthropicKey: pane.hasKey === null ? null : { hasKey: pane.hasKey } }),
}));
vi.mock('../../../context/schedule', () => ({
  useSchedule: () => ({ events: [], definitions: [], refreshCompletions: async () => {} }),
}));
vi.mock('../../../context/meals', () => ({ useMeals: () => ({ meals: [] }) }));
vi.mock('../../../hooks/useTip', () => ({ useTip: () => {} }));
vi.mock('../../coach/CoachModelPicker', () => ({ default: () => null }));

const request: AskCoachRequest = {
  kind: 'session', eventId: 'w1-mon-stretch__2026-06-22', date: '2026-06-22', title: 'Nightly Stretch — Upper', source: 'modal',
};

/** Render, then let the effect's async body (resolveContext → send) settle. */
async function mount() {
  const html = renderToStaticMarkup(<ChatSidebar />);
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return html;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pane.askCoach = request;
  pane.hasKey = true;
  pane.chat.isLoading = false;
  pane.chat.pendingAction = null;
  pane.chat.pendingActionCount = 0;
  pane.chat.messages = [];
  pane.dispatch.mockClear();
  pane.chat.sendMessage.mockClear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

describe('ChatSidebar — the ask-coach effect', () => {
  it('sends the pin as a hidden turn once the pane is idle, then clears it', async () => {
    await mount();
    expect(pane.chat.sendMessage).toHaveBeenCalledTimes(1);
    const [content, ctx, opts] = pane.chat.sendMessage.mock.calls[0] as unknown as [string, { today: string }, { display: string }];
    expect(content).toBe(askCoachPrompt(request));
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(opts).toEqual({ display: askCoachDisplay(request) });
    expect(pane.dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ASK_COACH' });
    // The clear lands before the send, so a second Ask mid-answer is new.
    expect(pane.dispatch.mock.invocationCallOrder[0]).toBeLessThan(pane.chat.sendMessage.mock.invocationCallOrder[0]);
  });

  it('waits while a turn is in flight, and sends once it is not', async () => {
    pane.chat.isLoading = true;
    await mount();
    expect(pane.chat.sendMessage).not.toHaveBeenCalled();
    expect(pane.dispatch).not.toHaveBeenCalled();

    pane.chat.isLoading = false;
    await mount();
    expect(pane.chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(pane.dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ASK_COACH' });
  });

  it('waits while a confirm card is pending', async () => {
    pane.chat.pendingAction = { toolUseId: 'tu-1', toolName: 'create_event', input: {}, displayLabel: 'Create: Leg day' };
    pane.chat.pendingActionCount = 1;
    await mount();
    expect(pane.chat.sendMessage).not.toHaveBeenCalled();
    expect(pane.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing with no pin', async () => {
    pane.askCoach = null;
    await mount();
    expect(pane.chat.sendMessage).not.toHaveBeenCalled();
    expect(pane.dispatch).not.toHaveBeenCalled();
  });

  it('with no key saved: clears the pin without sending — the key setup is what the athlete sees', async () => {
    pane.hasKey = false;
    const html = await mount();
    expect(pane.chat.sendMessage).not.toHaveBeenCalled();
    expect(pane.dispatch).toHaveBeenCalledTimes(1);
    expect(pane.dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ASK_COACH' });
    expect(html).toContain('Add key');
  });

  it('with the key status unknown: sends, and lets the server\'s 402 be the backstop', async () => {
    pane.hasKey = null;
    await mount();
    expect(pane.chat.sendMessage).toHaveBeenCalledTimes(1);
  });
});
