import { describe, expect, it } from 'vitest';
import { parseISO } from 'date-fns';
import {
  BLOCK_DRAFT_TEXT_MAX,
  EXISTING_BLOCKS_SHOWN,
  EXISTING_BLOCKS_TEXT_MAX,
  INTENT_MAX,
  NAME_MAX,
  TARGET_VALUE_MAX,
  applyBlockDraftUpdate,
  describeBlockDraft,
  describeExistingBlocks,
  describeObjectives,
  draftFromBlock,
  emptyBlockDraft,
  mondayOf,
  shortRange,
  type BlockDraft,
  type BlockDraftContext,
} from '../draft';
import type { Objective, TrainingBlock } from '../../../types/blocks';
import { buildPlannerVolatile } from '../../coach/prompt';

// 2026-09-28 is a Monday; the plan below starts the week after.
const TODAY = parseISO('2026-09-30'); // a Wednesday

const denali: Objective = { id: 'obj-denali', name: 'Denali', targetDate: '2027-06-01', discipline: 'alpine', notes: '', status: 'active' };
const existing: TrainingBlock = {
  id: 'blk-fall', name: 'Fall Base', intent: 'aerobic', phase: 'base',
  startDate: '2026-09-07', endDateExclusive: '2026-10-05', weeklyTargets: { cardioMinutes: 240 },
};

const ctx = (over: Partial<BlockDraftContext> = {}): BlockDraftContext =>
  ({ existing: [], objectives: [denali], today: TODAY, ...over });

const empty = (): BlockDraft => emptyBlockDraft(TODAY);

const PLAN = [
  { name: 'Base', phase: 'base', start_date: '2026-10-05', end_date: '2026-11-01', intent: 'aerobic foundation',
    objective_id: 'obj-denali', weekly_targets: { cardio_minutes: 300, vert: { value: 3000, unit: 'ft' } } },
  { name: 'Build', phase: 'build', start_date: '2026-11-02', end_date: '2026-11-29', weekly_targets: { cardio_minutes: 360, strength_sessions: 2 } },
  { name: 'Peak', phase: 'peak', start_date: '2026-11-30', end_date: '2026-12-20' },
  { name: 'Taper', phase: 'taper', start_date: '2026-12-21', end_date: '2026-12-27', weekly_targets: { cardio_minutes: 150 } },
];

function ok(result: ReturnType<typeof applyBlockDraftUpdate>) {
  if ('error' in result) throw new Error(`expected success, got: ${result.error}`);
  return result;
}
function bad(result: ReturnType<typeof applyBlockDraftUpdate>): string {
  if (!('error' in result)) throw new Error(`expected an error, got: ${result.summary}`);
  return result.error;
}

describe('applyBlockDraftUpdate — a whole plan', () => {
  it('replaces the list with contiguous, validated blocks and summarizes the phases', () => {
    const { draft, summary } = ok(applyBlockDraftUpdate(empty(), { blocks: PLAN }, ctx()));
    expect(draft.editingId).toBeNull();
    expect(draft.blocks).toHaveLength(4);
    expect(draft.blocks[0]).toEqual({
      name: 'Base', intent: 'aerobic foundation', phase: 'base', objectiveId: 'obj-denali',
      startDate: '2026-10-05', endDateExclusive: '2026-11-02',
      weeklyTargets: { cardioMinutes: 300, vert: { value: 3000, unit: 'ft' } },
    });
    // The inclusive Sunday becomes the exclusive next Monday; an unset phase and targets read as absent.
    expect(draft.blocks[2]).toEqual({
      name: 'Peak', intent: '', phase: 'peak', objectiveId: undefined,
      startDate: '2026-11-30', endDateExclusive: '2026-12-21', weeklyTargets: {},
    });
    expect(summary).toBe('Block draft updated: 4 blocks, Oct 5 – Dec 27 (base 4w · build 4w · peak 3w · taper 1w). The user reviews and presses Apply.');
  });

  it('counts one block in the singular and names an unphased block by its name', () => {
    const { summary } = ok(applyBlockDraftUpdate(empty(), { blocks: [{ name: 'Maintenance', start_date: '2026-10-05', end_date: '2026-10-18' }] }, ctx()));
    expect(summary).toBe('Block draft updated: 1 block, Oct 5 – Oct 18 (Maintenance 2w). The user reviews and presses Apply.');
  });

  it('spans a year end in the summary', () => {
    const { summary } = ok(applyBlockDraftUpdate(empty(), { blocks: [{ name: 'Winter', start_date: '2026-12-28', end_date: '2027-01-24' }] }, ctx()));
    expect(summary).toContain('Dec 28, 2026 – Jan 24, 2027');
    expect(shortRange('2026-12-28', '2027-01-25')).toBe('Dec 28, 2026 – Jan 24, 2027');
  });

  it('throws on a draft of another shape — the caller\'s bug, not a tool_result', () => {
    expect(() => applyBlockDraftUpdate({ title: 'CINDY' } as unknown as BlockDraft, { blocks: PLAN }, ctx())).toThrow('not a block draft');
  });

  it('leaves the input draft untouched', () => {
    const before = empty();
    ok(applyBlockDraftUpdate(before, { blocks: PLAN }, ctx()));
    expect(before.blocks).toEqual([]);
  });
});

describe('applyBlockDraftUpdate — the rules, each a sentence in ONE error', () => {
  it('asks for `blocks` when the update carries nothing, and refuses a non-array', () => {
    expect(bad(applyBlockDraftUpdate(empty(), {}, ctx()))).toContain('pass `blocks`');
    expect(bad(applyBlockDraftUpdate(empty(), { blocks: 'Base' }, ctx()))).toContain('must be an array');
  });

  it('needs at least one block and at most 24', () => {
    expect(bad(applyBlockDraftUpdate(empty(), { blocks: [] }, ctx()))).toBe('The draft needs at least one block.');
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: `W${i + 1}`,
      start_date: '2026-10-05', end_date: '2026-10-11',
    }));
    const error = bad(applyBlockDraftUpdate(empty(), { blocks: many }, ctx()));
    expect(error).toContain('cannot hold more than 24 blocks (got 25)');
  });

  it('an editing draft holds exactly one item', () => {
    const editing = draftFromBlock(existing);
    const error = bad(applyBlockDraftUpdate(editing, { blocks: [PLAN[0], PLAN[1]] }, ctx({ existing: [existing] })));
    expect(error).toContain('edits one existing block, so pass exactly one item (got 2)');
  });

  it('collects every field problem of every item, labelled by position and name', () => {
    const error = bad(applyBlockDraftUpdate(empty(), {
      blocks: [
        { phase: 'ramp', start_date: '2026-10-06', end_date: '2026-11-01', objective_id: 'obj-nope', weekly_targets: { cardio_minutes: -1, vert: { value: 3, unit: 'yd' } } },
        { name: 'Build', start_date: '2026-11-02', end_date: '2026-11-30', intent: 7, weekly_targets: { volume: 3 } },
        'not an object',
      ],
    }, ctx()));
    const sentences = error.split(/(?<=\.) (?=[A-Za-z`])/);
    expect(sentences).toEqual(expect.arrayContaining([
      'block 1: name is required.',
      'block 1: phase must be one of base, build, peak, taper, recovery, maintenance.',
      expect.stringContaining('block 1: objective_id "obj-nope" names no objective — the athlete\'s objectives are obj-denali (Denali).'),
      expect.stringContaining('block 1: start_date 2026-10-06 is not a Monday'),
      'block 1: cardio_minutes must be a non-negative number (at most 1000000).',
      expect.stringContaining("block 1: vert must be { value: a non-negative number (at most 1000000), unit: 'ft' | 'm' }."),
      'block 2 "Build": intent must be a string.',
      expect.stringContaining('block 2 "Build": end_date 2026-11-30 is not a Sunday'),
      'block 2 "Build": unknown weekly target volume — the targets are cardio_minutes, vert, distance, strength_sessions, climbing_sessions, long_session_minutes.',
      'block 3 must be an object with name, start_date and end_date.',
    ]));
    // The Monday hint names the week's Monday.
    expect(error).toContain("(the week's is 2026-10-05)");
  });

  it('tells the model there are no objectives to name when there are none', () => {
    const error = bad(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], objective_id: 'x' }] }, ctx({ objectives: [] })));
    expect(error).toContain('the athlete has no objectives; omit it');
  });

  it('runs validateBlock on each item: end after start, at most 52 weeks', () => {
    const backwards = bad(applyBlockDraftUpdate(empty(), { blocks: [{ name: 'B', start_date: '2026-11-02', end_date: '2026-10-11' }] }, ctx()));
    expect(backwards).toBe('block 1 "B": A block must end after it starts.');
    const long = bad(applyBlockDraftUpdate(empty(), { blocks: [{ name: 'L', start_date: '2026-10-05', end_date: '2027-10-10' }] }, ctx()));
    expect(long).toBe('block 1 "L": A block cannot be longer than 52 weeks (got 53).');
  });

  it('requires items to be contiguous and in date order', () => {
    const gap = bad(applyBlockDraftUpdate(empty(), { blocks: [PLAN[0], { ...PLAN[1], start_date: '2026-11-09', end_date: '2026-12-06' }] }, ctx()));
    expect(gap).toBe('Blocks must be contiguous and in date order: block 2 "Build" should start on 2026-11-02, the day after block 1 "Base" ends, but starts 2026-11-09.');
    const reversed = bad(applyBlockDraftUpdate(empty(), { blocks: [PLAN[1], PLAN[0]] }, ctx()));
    expect(reversed).toContain('block 2 "Base" should start on 2026-11-30');
  });

  it('refuses overlap with an existing block, naming both ranges', () => {
    const error = bad(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], start_date: '2026-09-28', end_date: '2026-11-01' }] }, ctx({ existing: [existing] })));
    expect(error).toBe('block 1 "Base" (Sep 28 – Nov 1) overlaps the existing block "Fall Base" (Sep 7 – Oct 4) — blocks cannot overlap; plan around it.');
    // The date rules still report when another field of the same item failed: every problem in one answer.
    const both = bad(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], start_date: '2026-09-28', end_date: '2026-11-01', objective_id: 'obj-nope' }] }, ctx({ existing: [existing] })));
    expect(both).toContain('names no objective');
    expect(both).toContain('overlaps the existing block "Fall Base"');
    // Butting up against it is fine.
    ok(applyBlockDraftUpdate(empty(), { blocks: [PLAN[0]] }, ctx({ existing: [existing] })));
  });

  it('lets an editing draft overlap only the block it replaces', () => {
    const editing = draftFromBlock(existing);
    const replacement = { name: 'Fall Base, longer', phase: 'base', start_date: '2026-09-07', end_date: '2026-10-11' };
    const other: TrainingBlock = { ...existing, id: 'blk-other', name: 'Other', startDate: '2026-10-12', endDateExclusive: '2026-10-26' };
    ok(applyBlockDraftUpdate(editing, { blocks: [replacement] }, ctx({ existing: [existing, other] })));
    const error = bad(applyBlockDraftUpdate(editing, { blocks: [{ ...replacement, end_date: '2026-10-18' }] }, ctx({ existing: [existing, other] })));
    expect(error).toContain('overlaps the existing block "Other"');
  });

  it('refuses a new block that starts before this week\'s Monday, but lets the edited block keep its past start', () => {
    const past = { name: 'Late', start_date: '2026-09-21', end_date: '2026-10-04' };
    const error = bad(applyBlockDraftUpdate(empty(), { blocks: [past] }, ctx()));
    expect(error).toBe('block 1 "Late" starts 2026-09-21, before this week\'s Monday (2026-09-28) — new blocks start this week or later.');
    // This week's Monday itself is allowed.
    ok(applyBlockDraftUpdate(empty(), { blocks: [{ ...past, start_date: '2026-09-28' }] }, ctx()));
    // The block being edited started in the past and may stay there.
    ok(applyBlockDraftUpdate(draftFromBlock(existing), { blocks: [{ name: 'Fall Base', start_date: '2026-09-07', end_date: '2026-10-04' }] }, ctx({ existing: [existing] })));
    expect(mondayOf(TODAY)).toBe('2026-09-28');
  });

  it(`caps intent at ${INTENT_MAX} characters so a full draft cannot outgrow the prompt`, () => {
    const long = 'x'.repeat(INTENT_MAX + 1);
    const error = bad(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], intent: long }] }, ctx()));
    expect(error).toBe(`block 1 "Base": intent is ${INTENT_MAX + 1} characters — keep it under ${INTENT_MAX} (one or two sentences on what the block is for).`);
    const { draft } = ok(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], intent: ` ${'y'.repeat(INTENT_MAX)} ` }] }, ctx()));
    expect(draft.blocks[0].intent).toHaveLength(INTENT_MAX);
  });

  it(`caps name at ${NAME_MAX} characters and target values at ${TARGET_VALUE_MAX}`, () => {
    const error = bad(applyBlockDraftUpdate(empty(), {
      blocks: [{ ...PLAN[0], name: 'n'.repeat(NAME_MAX + 1), weekly_targets: { cardio_minutes: TARGET_VALUE_MAX + 1, vert: { value: TARGET_VALUE_MAX + 1, unit: 'ft' } } }],
    }, ctx()));
    expect(error).toContain(`name is ${NAME_MAX + 1} characters — keep it under ${NAME_MAX}.`);
    expect(error).toContain(`cardio_minutes must be a non-negative number (at most ${TARGET_VALUE_MAX}).`);
    expect(error).toContain(`vert must be { value: a non-negative number (at most ${TARGET_VALUE_MAX}), unit: 'ft' | 'm' }.`);
    ok(applyBlockDraftUpdate(empty(), { blocks: [{ ...PLAN[0], name: 'n'.repeat(NAME_MAX), weekly_targets: { cardio_minutes: TARGET_VALUE_MAX } }] }, ctx()));
  });

  it('accepts null for the optional fields', () => {
    const { draft } = ok(applyBlockDraftUpdate(empty(), {
      blocks: [{ name: 'B', start_date: '2026-10-05', end_date: '2026-10-11', phase: null, intent: null, objective_id: null, weekly_targets: null }],
    }, ctx()));
    expect(draft.blocks[0]).toEqual({ name: 'B', intent: '', phase: undefined, objectiveId: undefined, startDate: '2026-10-05', endDateExclusive: '2026-10-12', weeklyTargets: {} });
  });
});

describe('describeBlockDraft', () => {
  it('renders an empty draft', () => {
    expect(describeBlockDraft(empty())).toBe('(no blocks yet)');
  });

  it('renders each block in the tool\'s vocabulary, with inclusive end dates and the targets', () => {
    const { draft } = ok(applyBlockDraftUpdate(empty(), { blocks: PLAN.slice(0, 2) }, ctx()));
    expect(describeBlockDraft(draft)).toBe([
      '1. Base · phase base · start_date 2026-10-05 · end_date 2026-11-01 (4 weeks) · objective_id obj-denali',
      '   intent: aerobic foundation',
      '   weekly_targets: cardio_minutes 300 · vert 3000 ft',
      '2. Build · phase build · start_date 2026-11-02 · end_date 2026-11-29 (4 weeks)',
      '   weekly_targets: cardio_minutes 360 · strength_sessions 2',
    ].join('\n'));
  });

  it('says which block an editing draft replaces', () => {
    const text = describeBlockDraft(draftFromBlock(existing));
    expect(text.split('\n')[0]).toBe('Editing existing block blk-fall — the draft holds exactly its replacement.');
    expect(text).toContain('1. Fall Base · phase base · start_date 2026-09-07 · end_date 2026-10-04 (4 weeks)');
  });

  it('throws on anything that is not a block draft', () => {
    expect(() => describeBlockDraft({ title: 'CINDY', lists: {} })).toThrow('not a block draft');
    expect(() => describeBlockDraft({ editingId: null, blocks: [{ name: 1 }] })).toThrow('not a block draft');
    expect(() => describeBlockDraft(null)).toThrow('not a block draft');
    expect(() => describeBlockDraft({ editingId: 5, blocks: [] })).toThrow('not a block draft');
  });
});

describe('describeExistingBlocks / describeObjectives', () => {
  it('lists blocks in date order with id, phase, range, objective and targets', () => {
    const later: TrainingBlock = { ...existing, id: 'blk-later', name: 'Winter', phase: undefined, objectiveId: 'obj-denali', startDate: '2026-12-07', endDateExclusive: '2026-12-14', weeklyTargets: {} };
    expect(describeExistingBlocks([later, existing], [denali], TODAY)).toBe([
      '- [blk-later] Winter · 2026-12-07 → 2026-12-13 (1 week) · objective "Denali"',
      '- [blk-fall] Fall Base · phase base · 2026-09-07 → 2026-10-04 (4 weeks) · cardio_minutes 240',
    ].join('\n'));
    expect(describeExistingBlocks([], [], TODAY)).toBe('(no blocks yet)');
  });

  it('lists newest first and stops at the count bound, saying how many more there are — never a half-described block', () => {
    const many: TrainingBlock[] = Array.from({ length: EXISTING_BLOCKS_SHOWN + 2 }, (_, i) => ({
      ...existing, id: `blk-${i}`, name: `Block ${i}`, phase: undefined, weeklyTargets: {},
      startDate: `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-04`, endDateExclusive: `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-11`,
    }));
    const lines = describeExistingBlocks(many, [], TODAY).split('\n');
    expect(lines).toHaveLength(EXISTING_BLOCKS_SHOWN + 1);
    expect(lines[0]).toBe(`(2 more blocks not shown — only the ${EXISTING_BLOCKS_SHOWN} newest are listed)`);
    expect(lines[1]).toContain(`[blk-${EXISTING_BLOCKS_SHOWN + 1}]`);
    expect(lines[EXISTING_BLOCKS_SHOWN]).toContain('[blk-2]');
    // Every listed line is whole: it ends with its date range or a later field, never mid-word.
    for (const line of lines.slice(1)) expect(line).toMatch(/\(1 week\)$/);
  });

  it('shows only blocks ending on or after this week\'s Monday and counts the earlier ones, so a long history cannot cut the relevant ones', () => {
    // 30 old four-week blocks, then one ending exactly on this Monday (still relevant: it butts up against the week), then the current one.
    const old: TrainingBlock[] = Array.from({ length: 30 }, (_, i) => ({
      ...existing, id: `blk-old-${i}`, name: `Old ${i}`, intent: 'x'.repeat(200),
      startDate: '2024-01-01', endDateExclusive: '2024-01-29',
    }));
    const endsMonday: TrainingBlock = { ...existing, id: 'blk-edge', name: 'Edge', startDate: '2026-08-31', endDateExclusive: '2026-09-28', weeklyTargets: {} };
    const endsSunday: TrainingBlock = { ...existing, id: 'blk-gone', name: 'Gone', startDate: '2026-08-24', endDateExclusive: '2026-09-27', weeklyTargets: {} };
    const text = describeExistingBlocks([existing, ...old, endsMonday, endsSunday], [denali], TODAY);
    expect(text.split('\n')).toEqual([
      '(31 earlier blocks not shown — all ended before 2026-09-28)',
      '- [blk-fall] Fall Base · phase base · 2026-09-07 → 2026-10-04 (4 weeks) · cardio_minutes 240',
      '- [blk-edge] Edge · phase base · 2026-08-31 → 2026-09-27 (4 weeks)',
    ]);
    expect(text.length).toBeLessThan(8000);
    // Only history: the count alone.
    expect(describeExistingBlocks([endsSunday], [], TODAY)).toBe('(1 earlier block not shown — all ended before 2026-09-28)');
  });

  it('lists objectives with the ids objective_id takes', () => {
    expect(describeObjectives([denali, { id: 'obj-2', name: 'Run a 50k', notes: '', status: 'achieved' }])).toBe([
      '- [obj-denali] Denali · alpine · target 2027-06-01 · active',
      '- [obj-2] Run a 50k · undated · achieved',
    ].join('\n'));
    expect(describeObjectives([])).toBe('(no objectives yet)');
  });
});

describe('the prompt caps fit the maximal draft and existing-blocks section', () => {
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const objectives: Objective[] = Array.from({ length: 24 }, (_, i) => ({ id: uuid(i), name: 'o'.repeat(NAME_MAX), notes: '', status: 'active' }));
  const maximalTargets = {
    cardio_minutes: TARGET_VALUE_MAX, vert: { value: TARGET_VALUE_MAX, unit: 'ft' }, distance: { value: TARGET_VALUE_MAX, unit: 'km' },
    strength_sessions: TARGET_VALUE_MAX, climbing_sessions: TARGET_VALUE_MAX, long_session_minutes: TARGET_VALUE_MAX,
  };
  // 24 contiguous 52-week blocks at every bound, from this Monday.
  const maximalItems = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(Date.UTC(2026, 8, 28 + i * 364));
    const end = new Date(start.getTime() + 363 * 86_400_000);
    return {
      name: 'n'.repeat(NAME_MAX), intent: 'i'.repeat(INTENT_MAX), phase: 'maintenance', objective_id: uuid(i),
      start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), weekly_targets: maximalTargets,
    };
  });

  it('a 24-item draft at every bound survives buildPlannerVolatile uncut, editing header included', () => {
    const { draft } = ok(applyBlockDraftUpdate(empty(), { blocks: maximalItems }, ctx({ objectives })));
    expect(draft.blocks).toHaveLength(24);
    const editing = { ...draft, editingId: uuid(99) };
    const text = describeBlockDraft(editing);
    expect(text.length).toBeLessThanOrEqual(BLOCK_DRAFT_TEXT_MAX);
    const volatile = buildPlannerVolatile(text, '(no blocks yet)', '(no objectives yet)', TODAY);
    expect(volatile).toContain(text);
    expect(volatile.split('\n').find(l => l.startsWith('24. '))).toBe(text.split('\n').find(l => l.startsWith('24. ')));
  });

  it(`${EXISTING_BLOCKS_SHOWN} maximal existing-block lines plus both "not shown" lines survive uncut`, () => {
    const blocks: TrainingBlock[] = Array.from({ length: EXISTING_BLOCKS_SHOWN + 5 }, (_, i) => ({
      id: uuid(i), name: 'b'.repeat(NAME_MAX + 40), intent: '', phase: 'maintenance', objectiveId: uuid(0),
      startDate: '2026-09-28', endDateExclusive: '2027-09-27',
      weeklyTargets: { cardioMinutes: TARGET_VALUE_MAX, vert: { value: TARGET_VALUE_MAX, unit: 'ft' }, distance: { value: TARGET_VALUE_MAX, unit: 'km' }, strengthSessions: TARGET_VALUE_MAX, climbingSessions: TARGET_VALUE_MAX, longSessionMinutes: TARGET_VALUE_MAX },
    }));
    const past: TrainingBlock[] = Array.from({ length: 999 }, (_, i) => ({ ...blocks[0], id: `p${i}`, startDate: '2020-01-06', endDateExclusive: '2020-01-13' }));
    const text = describeExistingBlocks([...past, ...blocks], [{ ...objectives[0], name: 'o'.repeat(NAME_MAX + 40) }], TODAY);
    const lines = text.split('\n');
    expect(lines).toHaveLength(EXISTING_BLOCKS_SHOWN + 2);
    // Over-long names made elsewhere are clipped to the bound, so a line is bounded too.
    expect(lines[2]).toContain(`${'b'.repeat(NAME_MAX - 1)}…`);
    expect(lines[2]).toContain(`objective "${'o'.repeat(NAME_MAX - 1)}…"`);
    expect(text.length).toBeLessThanOrEqual(EXISTING_BLOCKS_TEXT_MAX);
    const volatile = buildPlannerVolatile('(no blocks yet)', text, '(no objectives yet)', TODAY);
    expect(volatile).toContain(text);
  });
});
