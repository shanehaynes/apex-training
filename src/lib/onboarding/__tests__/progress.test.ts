import { describe, it, expect } from 'vitest';
import { localSetupDone, checklistRows, type LocalSignals, type RemoteSignals } from '../progress';

const local = (over: Partial<LocalSignals> = {}): LocalSignals => ({
  templateCopiedAt: null,
  hasAnthropicKey: false,
  coachGoal: '',
  ...over,
});

const remote = (over: Partial<RemoteSignals> = {}): RemoteSignals => ({
  corosConnected: false,
  corosConfigured: true,
  hasConnector: false,
  ...over,
});

describe('localSetupDone', () => {
  it('ticks nothing for a brand-new account', () => {
    expect(localSetupDone(local())).toEqual({ template: false, key: false, goal: false });
  });

  it('ticks the template once it has been copied', () => {
    expect(localSetupDone(local({ templateCopiedAt: '2026-08-12T00:00:00Z' })).template).toBe(true);
  });

  it('ticks the goal only when it holds something', () => {
    expect(localSetupDone(local({ coachGoal: 'Climb 5.13a' })).goal).toBe(true);
    expect(localSetupDone(local({ coachGoal: '   ' })).goal).toBe(false);
  });

  it('treats an unresolved key as done, so the nudge cannot flash on cold load', () => {
    expect(localSetupDone(local({ hasAnthropicKey: null })).key).toBe(true);
    expect(localSetupDone(local({ hasAnthropicKey: false })).key).toBe(false);
  });
});

describe('checklistRows', () => {
  it('offers every row, none done, for a fresh account', () => {
    const rows = checklistRows(local(), remote());
    expect(rows.map(r => r.id)).toEqual(['template', 'key', 'goal', 'coros', 'connector']);
    expect(rows.every(r => !r.done)).toBe(true);
  });

  it('drops the COROS row when the deployment has no watch provider configured', () => {
    const rows = checklistRows(local(), remote({ corosConfigured: false }));
    expect(rows.map(r => r.id)).not.toContain('coros');
    expect(rows).toHaveLength(4);
  });

  it('keeps the COROS row when configured but not yet connected', () => {
    const row = checklistRows(local(), remote()).find(r => r.id === 'coros');
    expect(row?.done).toBe(false);
  });

  it('ticks COROS once connected', () => {
    const row = checklistRows(local(), remote({ corosConnected: true })).find(r => r.id === 'coros');
    expect(row?.done).toBe(true);
  });

  it('ticks the connector row for a token OR an OAuth connection', () => {
    const row = checklistRows(local(), remote({ hasConnector: true })).find(r => r.id === 'connector');
    expect(row?.done).toBe(true);
  });

  it('leaves the connector row unticked while the token list is unresolved', () => {
    const row = checklistRows(local(), remote({ hasConnector: null })).find(r => r.id === 'connector');
    expect(row?.done).toBe(false);
  });

  it('reports everything done for a fully set-up account', () => {
    const rows = checklistRows(
      local({ templateCopiedAt: '2026-08-12T00:00:00Z', hasAnthropicKey: true, coachGoal: 'Summit Denali' }),
      remote({ corosConnected: true, hasConnector: true }),
    );
    expect(rows.every(r => r.done)).toBe(true);
  });

  it('carries the copy through, so a row always has something to render', () => {
    for (const row of checklistRows(local(), remote())) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.hint.length).toBeGreaterThan(0);
      expect(row.action.label.length).toBeGreaterThan(0);
    }
  });
});
