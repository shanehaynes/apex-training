import { ChevronDown } from 'lucide-react';
import { DOCTRINE_TOPICS, readDoctrine, type DoctrineTopic } from '../../lib/coach/doctrine/index';
import { doctrineBlocks, type DoctrineBlock } from '../../lib/coach/notebook';

// The Doctrine tab: the method the coach prescribes from, read-only — one
// expandable section per topic, in the curriculum order the coach itself
// sees (src/lib/coach/doctrine/index.ts). The text is the same plain prose
// the model reads; doctrineBlocks() turns its headings, paragraphs and
// numbered points into markup, with no markdown dependency. Native
// <details> does the expanding: no state, works on a phone, and a closed
// topic costs nothing to scroll past.

const BLOCKS = new Map<string, DoctrineBlock[]>(
  DOCTRINE_TOPICS.map(t => [t.id, doctrineBlocks(readDoctrine(t.id) ?? t.text)]),
);

export default function DoctrineTab() {
  return (
    <div className="notebook-doctrine-tab">
      <p className="profile-hint">
        The method I coach from. It doesn't change from here — Memory is what I know about
        you, the Contract is how we work together, and this is the ground both stand on.
      </p>
      <div className="notebook-topics">
        {DOCTRINE_TOPICS.map(topic => (
          <DoctrineTopicSection key={topic.id} topic={topic} blocks={BLOCKS.get(topic.id) ?? []} />
        ))}
      </div>
    </div>
  );
}

export function DoctrineTopicSection({ topic, blocks }: { topic: DoctrineTopic; blocks: DoctrineBlock[] }) {
  return (
    <details className="notebook-topic" data-testid="doctrine-topic" data-topic={topic.id}>
      <summary className="notebook-topic__summary">
        <span className="notebook-topic__head">
          <span className="notebook-topic__title">{topic.title}</span>
          <span className="notebook-topic__blurb">{topic.summary}</span>
        </span>
        <ChevronDown className="notebook-topic__chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      </summary>
      <div className="notebook-topic__body">
        <DoctrineText blocks={blocks} />
      </div>
    </details>
  );
}

export function DoctrineText({ blocks }: { blocks: DoctrineBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return <h4 key={i} className="notebook-topic__heading">{block.text}</h4>;
          case 'list':
            return block.ordered
              ? <ol key={i} className="notebook-topic__list">{block.items.map((item, j) => <li key={j}>{item}</li>)}</ol>
              : <ul key={i} className="notebook-topic__list">{block.items.map((item, j) => <li key={j}>{item}</li>)}</ul>;
          default:
            return <p key={i} className="notebook-topic__para">{block.text}</p>;
        }
      })}
    </>
  );
}
