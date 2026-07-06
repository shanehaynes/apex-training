import { describe, it, expect, vi } from 'vitest';
import { COACH_TOOLS, coachToolSchemas, findCoachTool } from '../tools';
import type { CoachToolDeps } from '../tools';

function makeDeps(overrides: Partial<CoachToolDeps> = {}): CoachToolDeps {
  return {
    createEvent: vi.fn(async () => ({ id: 'new-1' })),
    updateEvent: vi.fn(async () => true),
    deleteEvent: vi.fn(async () => true),
    deleteEventInstance: vi.fn(async () => true),
    rescheduleEvent: vi.fn(async () => true),
    ...overrides,
  };
}

describe('coach tool registry', () => {
  it('exposes each tool exactly once, findable by schema name', () => {
    const names = coachToolSchemas().map(s => s.name);
    expect(names).toEqual(['delete_event', 'create_event', 'update_event']);
    for (const name of names) expect(findCoachTool(name)?.schema.name).toBe(name);
    expect(findCoachTool('nope')).toBeUndefined();
  });

  it('every tool has a label and executor colocated with its schema', () => {
    for (const tool of COACH_TOOLS) {
      expect(typeof tool.displayLabel({})).toBe('string');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('delete_event routes instance scope through deleteEventInstance with the base id', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('delete_event')!.execute(
      { event_id: 'base__2026-07-06', scope: 'instance', date: '2026-07-06', event_title: 'Yoga' },
      deps,
    );
    expect(deps.deleteEventInstance).toHaveBeenCalledWith('base', '2026-07-06');
    expect(deps.deleteEvent).not.toHaveBeenCalled();
    expect(result).toMatch(/instance/);
  });

  it('delete_event routes scope=all through deleteEvent', async () => {
    const deps = makeDeps();
    await findCoachTool('delete_event')!.execute(
      { event_id: 'abc', scope: 'all', event_title: 'Yoga' },
      deps,
    );
    expect(deps.deleteEvent).toHaveBeenCalledWith('abc');
  });

  it('create_event maps snake_case tool input to CreateEventInput', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('create_event')!.execute(
      { type: 'yoga', title: 'Flow', date: '2026-07-08', estimated_duration: 30, start_time: '7:00 AM' },
      deps,
    );
    expect(deps.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yoga', title: 'Flow', date: '2026-07-08', estimatedDuration: 30, startTime: '7:00 AM',
    }));
    expect(result).toContain('Flow');
  });

  it('update_event forwards only the changed fields, camelCased', async () => {
    const deps = makeDeps();
    await findCoachTool('update_event')!.execute(
      { event_id: 'abc', event_title: 'Yoga', changes: { start_time: '6:00 AM', difficulty: 4 } },
      deps,
    );
    expect(deps.updateEvent).toHaveBeenCalledWith({
      id: 'abc',
      fields: { startTime: '6:00 AM', difficulty: 4 },
    });
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
  });

  it('update_event routes date/time-only changes on an occurrence id through rescheduleEvent', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('update_event')!.execute(
      {
        event_id: 'base__2026-07-06',
        event_title: 'Yoga',
        changes: { date: '2026-07-07', start_time: '6:00 AM' },
      },
      deps,
    );
    expect(deps.rescheduleEvent).toHaveBeenCalledWith('base__2026-07-06', {
      date: '2026-07-07',
      startTime: '6:00 AM',
    });
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(result).toMatch(/occurrence/i);
  });

  it('update_event rejects non-schedule fields on an occurrence id without mutating anything', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('update_event')!.execute(
      {
        event_id: 'base__2026-07-06',
        event_title: 'Yoga',
        changes: { title: 'Hot Yoga', start_time: '6:00 AM' },
      },
      deps,
    );
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(result).toContain('title');
    expect(result).toContain('"base"');
  });

  it('update_event keeps whole-series behavior for base ids', async () => {
    const deps = makeDeps();
    await findCoachTool('update_event')!.execute(
      { event_id: 'base', event_title: 'Yoga', changes: { title: 'Hot Yoga', date: '2026-07-07' } },
      deps,
    );
    expect(deps.updateEvent).toHaveBeenCalledWith({
      id: 'base',
      fields: { title: 'Hot Yoga', date: '2026-07-07' },
    });
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
  });

  it('builds human-readable confirmation labels', () => {
    expect(findCoachTool('delete_event')!.displayLabel({
      event_title: 'Upper Body', event_date_display: 'Mon Jun 29', scope: 'instance',
    })).toBe('Delete: Upper Body · Mon Jun 29 (this instance)');
    expect(findCoachTool('create_event')!.displayLabel({
      title: 'Flow', type: 'yoga', date: '2026-07-08',
    })).toBe('Create: Flow · yoga · 2026-07-08');
    expect(findCoachTool('update_event')!.displayLabel({
      event_title: 'Yoga', changes: { start_time: '6:00 AM' },
    })).toBe('Update: Yoga (start_time)');
  });
});
