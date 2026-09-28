import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftCard, DraftEmpty, editFields } from '../BlockPlanner';
import { blockFieldsToRow } from '../../../lib/blocks/mapping';
import { ReadChips } from '../BlockPlannerPanel';
import type { BlockDraftItem } from '../../../lib/blocks/draft';

// This repo has no DOM test environment (see AnnotationChip.test.tsx), so the
// planner is proved at the markup level: what a draft card says and how it
// is marked. The stateful flow — the coach's update_block_draft landing as
// cards, Apply posting the batch — is proved in the mock e2e
// (e2e/mock/block-planner.spec.ts).

const base: BlockDraftItem = {
  name: 'Base', intent: 'Aerobic foundation: long easy days, one strength session.', phase: 'base', objectiveId: 'obj-denali',
  startDate: '2026-10-05', endDateExclusive: '2026-11-02',
  weeklyTargets: { cardioMinutes: 300, vert: { value: 3000, unit: 'ft' }, strengthSessions: 1 },
};

describe('DraftCard', () => {
  it('shows the position, name, phase, range with weeks, intent, targets with units, and the objective', () => {
    const html = renderToStaticMarkup(
      <DraftCard index={0} block={base} objective={{ id: 'obj-denali', name: 'Denali', notes: '', status: 'active' }} onRemove={() => {}} />,
    );
    expect(html).toContain('data-testid="block-draft-card"');
    expect(html).toContain('class="block-planner__card block-planner__card--base"');
    expect(html).toContain('<span class="block-planner__index">1</span>');
    expect(html).toContain('<span class="block-planner__name">Base</span>');
    expect(html).toContain('<span class="block-planner__phase">base</span>');
    expect(html).toContain('Oct 5 – Nov 1, 2026 · 4 weeks');
    expect(html).toContain('Aerobic foundation: long easy days, one strength session.');
    expect(html).toContain('<dt>Cardio</dt><dd>300 min</dd>');
    expect(html).toContain('<dt>Vertical gain</dt><dd>3,000 ft</dd>');
    expect(html).toContain('<dt>Strength</dt><dd>1 sessions</dd>');
    expect(html).not.toContain('Distance');
    expect(html).toContain('Objective: Denali');
    expect(html).toContain('aria-label="Remove Base from the draft"');
  });

  it('omits what a block does not have: phase, intent, targets, objective', () => {
    const html = renderToStaticMarkup(
      <DraftCard index={2} block={{ ...base, phase: undefined, intent: '', objectiveId: undefined, weeklyTargets: {}, endDateExclusive: '2026-10-12' }} objective={null} onRemove={() => {}} />,
    );
    expect(html).toContain('class="block-planner__card"');
    expect(html).toContain('<span class="block-planner__index">3</span>');
    expect(html).toContain('Oct 5 – Oct 11, 2026 · 1 week');
    expect(html).not.toContain('block-planner__phase');
    expect(html).not.toContain('block-planner__intent');
    expect(html).not.toContain('<dl');
    expect(html).not.toContain('Objective:');
  });
});

describe('DraftEmpty', () => {
  it('tells a new plan how to start and an edit what Cancel keeps', () => {
    expect(renderToStaticMarkup(<DraftEmpty editing={false} />)).toContain('No blocks drafted yet');
    expect(renderToStaticMarkup(<DraftEmpty editing={true} />)).toContain('Cancel to keep it as it is');
  });
});

describe('ReadChips', () => {
  it('renders one chip per label in order, marked as what the coach checked, with the sidebar\'s classes', () => {
    const html = renderToStaticMarkup(<ReadChips labels={['Checked: training blocks', 'Doctrine: Periodization']} />);
    expect(html).toContain('class="chat-reads" data-testid="chat-reads" aria-label="What the coach checked"');
    expect(html.match(/class="chat-reads__chip"/g)).toHaveLength(2);
    expect(html.indexOf('Checked: training blocks')).toBeLessThan(html.indexOf('Doctrine: Periodization'));
    expect(renderToStaticMarkup(<ReadChips labels={['x']} streaming />)).toContain('class="chat-reads chat-reads--streaming"');
  });
});

describe('editFields — the PATCH a redraw sends', () => {
  it('clears a phase and an objective the redrawn block no longer has, instead of leaving the old ones', () => {
    const cleared = editFields({ ...base, phase: undefined, objectiveId: undefined });
    expect(blockFieldsToRow(cleared)).toMatchObject({ phase: null, objective_id: null, name: 'Base', start_date: '2026-10-05' });
    // blockFieldsToRow would have dropped them as undefined — the gap this closes.
    expect(blockFieldsToRow({ ...base, phase: undefined, objectiveId: undefined })).not.toHaveProperty('phase');
    expect(blockFieldsToRow({ ...base, phase: undefined, objectiveId: undefined })).not.toHaveProperty('objective_id');
  });

  it('keeps a phase and objective the block has', () => {
    expect(blockFieldsToRow(editFields(base))).toMatchObject({ phase: 'base', objective_id: 'obj-denali', weekly_targets: base.weeklyTargets });
  });
});
