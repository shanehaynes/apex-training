import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookTabs } from '../NotebookView';
import { AddMemoryForm, MemoryEmpty, MemoryGroups, ProposalCard } from '../MemoryTab';
import { ReflectionCard } from '../ContractTab';
import DoctrineTab, { DoctrineText, DoctrineTopicSection } from '../DoctrineTab';
import { DOCTRINE_TOPICS } from '../../../lib/coach/doctrine/index';
import { doctrineBlocks, splitMemories, type CoachReflection } from '../../../lib/coach/notebook';
import type { CoachMemory } from '../../../lib/coach/memory';

// This repo has no DOM test environment (see AnnotationChip.test.tsx), so the
// notebook is proved at the markup level: what each piece says, how it is
// marked, which controls exist. The stateful flows — a proposal accepted
// and moving into the confirmed list, the contract tab's "not available
// yet" banner on a pre-D01 server, save and opt-in PATCHes — are proved in
// the mock e2e (e2e/mock/coach-notebook.spec.ts).

function memory(over: Partial<CoachMemory>): CoachMemory {
  return {
    id: 'm1',
    kind: 'injury',
    content: 'Left knee: no deep squats until the physio clears it',
    confidence: 0.8,
    source_kind: 'reflection',
    created_at: '2026-09-07T08:00:00Z',
    confirmed_at: null,
    confirmed: false,
    ...over,
  };
}

const REFLECTION: CoachReflection = {
  id: 'r1',
  day: '2026-09-07',
  status: 'pending',
  contract_before: 'Push me on consistency.\nAsk before moving a long day.',
  contract_after: 'Push me on consistency.\nNever program through knee pain.\nAsk before moving a long day.',
  reason: 'You mentioned the knee twice this week and I programmed through it once.',
  memory_proposal_ids: ['m1', 'm2'],
  created_at: '2026-09-08T03:00:00Z',
  resolved_at: null,
  resolution: null,
};

describe('NotebookTabs', () => {
  it('renders the three tabs with the active one selected', () => {
    const html = renderToStaticMarkup(<NotebookTabs tab="contract" onChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="notebook-tab-memory"');
    expect(html).toContain('id="notebook-tab-contract" type="button" role="tab" class="notebook-tab" aria-selected="true"');
    expect(html).toContain('id="notebook-tab-doctrine"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('>Memory<');
    expect(html).toContain('>Contract<');
    expect(html).toContain('>Doctrine<');
  });
});

describe('ProposalCard', () => {
  it('shows the fact, its kind, where it came from, and Accept / Forget', () => {
    const html = renderToStaticMarkup(<ProposalCard memory={memory({})} onAccept={() => {}} onForget={() => {}} />);
    expect(html).toContain('data-testid="memory-proposal"');
    expect(html).toContain('data-kind="injury"');
    expect(html).toContain('Left knee: no deep squats until the physio clears it');
    expect(html).toContain('<span class="notebook-chip">injuries</span>');
    expect(html).toContain('from an overnight reflection');
    expect(html).toContain('data-testid="memory-accept"');
    expect(html).toContain('data-testid="memory-forget"');
  });

  it('says nothing about the source when there is none', () => {
    const html = renderToStaticMarkup(<ProposalCard memory={memory({ source_kind: null })} onAccept={() => {}} onForget={() => {}} />);
    expect(html).not.toContain(' · ');
  });
});

describe('MemoryGroups', () => {
  it('renders one group per kind in the prompt order, each row with a Forget control', () => {
    const { confirmed } = splitMemories([
      memory({ id: 'n', kind: 'note', content: 'Trains before work', confirmed: true, confirmed_at: '2026-09-07T08:00:00Z' }),
      memory({ id: 'g', kind: 'goal', content: 'Rainier, June 2027', confirmed: true, confirmed_at: '2026-09-07T08:00:00Z' }),
    ]);
    const html = renderToStaticMarkup(<MemoryGroups groups={confirmed} onForget={() => {}} />);
    expect(html.indexOf('data-testid="memory-group-goal"')).toBeLessThan(html.indexOf('data-testid="memory-group-note"'));
    expect(html).toContain('<h4 class="notebook-group__title">goals</h4>');
    expect(html).toContain('<span class="notebook-memory__text">Rainier, June 2027</span>');
    expect(html.match(/aria-label="Forget this"/g)).toHaveLength(2);
    expect(html).not.toContain('memory-group-injury');
  });
});

describe('MemoryEmpty', () => {
  it('speaks in the coach’s voice, and differently when proposals are waiting', () => {
    // React escapes the apostrophe on the way out.
    expect(renderToStaticMarkup(<MemoryEmpty proposed={false} />)).toContain('I don&#x27;t hold anything about you yet');
    expect(renderToStaticMarkup(<MemoryEmpty proposed />)).toContain('waiting on you');
  });
});

describe('AddMemoryForm', () => {
  it('offers every kind in the prompt order and counts against the 500-character cap', () => {
    const html = renderToStaticMarkup(<AddMemoryForm onAdd={async () => true} />);
    const options = [...html.matchAll(/<option value="([a-z]+)"/g)].map(m => m[1]);
    expect(options).toEqual(['injury', 'goal', 'preference', 'history', 'note']);
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('0 / 500');
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
  });
});

describe('ReflectionCard', () => {
  it('shows the day, the reason, the before/after diff with changed lines marked, the memory note, Accept / Reject', () => {
    const html = renderToStaticMarkup(<ReflectionCard reflection={REFLECTION} onResolve={() => {}} />);
    expect(html).toContain('data-reflection-id="r1"');
    expect(html).toContain('Monday 7 September');
    expect(html).toContain('You mentioned the knee twice this week');
    expect(html).toContain('data-testid="reflection-diff"');
    // The added line is marked on the after side only; the shared lines are not.
    expect(html).toContain('<span class="notebook-diff__line notebook-diff__line--changed">Never program through knee pain.</span>');
    expect(html.match(/notebook-diff__line--changed/g)).toHaveLength(1);
    expect(html).toContain('<span class="notebook-diff__line">Push me on consistency.</span>');
    expect(html).toContain('Also proposes 2 memories');
    expect(html).toContain('data-testid="reflection-accept"');
    expect(html).toContain('data-testid="reflection-reject"');
  });

  it('marks a removed line on the before side', () => {
    const r = { ...REFLECTION, contract_before: 'Keep this.\nDrop this.', contract_after: 'Keep this.', memory_proposal_ids: ['x'] };
    const html = renderToStaticMarkup(<ReflectionCard reflection={r} onResolve={() => {}} />);
    expect(html).toContain('notebook-diff__block--before');
    expect(html).toContain('<span class="notebook-diff__line notebook-diff__line--changed">Drop this.</span>');
    expect(html).toContain('Also proposes one memory');
  });

  it('leaves the diff out when the reflection proposes memories only', () => {
    const r = { ...REFLECTION, contract_after: REFLECTION.contract_before };
    const html = renderToStaticMarkup(<ReflectionCard reflection={r} onResolve={() => {}} />);
    expect(html).not.toContain('reflection-diff');
    expect(html).toContain('Also proposes 2 memories');
  });
});

describe('Doctrine', () => {
  it('renders every topic as an expandable section in curriculum order', () => {
    const html = renderToStaticMarkup(<DoctrineTab />);
    const ids = [...html.matchAll(/data-topic="([a-z-]+)"/g)].map(m => m[1]);
    expect(ids).toEqual(DOCTRINE_TOPICS.map(t => t.id));
    expect(html.match(/<details class="notebook-topic"/g)).toHaveLength(DOCTRINE_TOPICS.length);
    // React escapes the apostrophe in "This athlete's …" on the way out.
    for (const topic of DOCTRINE_TOPICS) expect(html).toContain(topic.title.replace(/'/g, '&#x27;'));
  });

  it('renders headings as h4, numbered points as an ordered list, prose as paragraphs', () => {
    const blocks = doctrineBlocks('Intro line.\n\n## A heading\n\n1. First.\n\n2. Second.');
    const html = renderToStaticMarkup(<DoctrineText blocks={blocks} />);
    expect(html).toBe(
      '<p class="notebook-topic__para">Intro line.</p>' +
      '<h4 class="notebook-topic__heading">A heading</h4>' +
      '<ol class="notebook-topic__list"><li>First.</li><li>Second.</li></ol>',
    );
  });

  it('shows a topic’s title and summary in its summary row', () => {
    const topic = DOCTRINE_TOPICS[0];
    const html = renderToStaticMarkup(<DoctrineTopicSection topic={topic} blocks={doctrineBlocks(topic.text)} />);
    expect(html).toContain(`<span class="notebook-topic__title">${topic.title}</span>`);
    expect(html).toContain(topic.summary);
    expect(html).toContain('notebook-topic__body');
  });
});
