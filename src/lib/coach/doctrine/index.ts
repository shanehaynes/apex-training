import type Anthropic from '@anthropic-ai/sdk';
import type { DoctrineTopic, DoctrineTopicId } from './types.js';
import { PRINCIPLES } from './principles.js';
import { AEROBIC_BASE } from './aerobicBase.js';
import { PERIODIZATION } from './periodization.js';
import { STRENGTH } from './strength.js';
import { CLIMBING } from './climbing.js';
import { RECOVERY } from './recovery.js';
import { MOBILITY } from './mobility.js';
import { ATHLETE_IDEAL } from './athleteIdeal.js';

export type { DoctrineTopic, DoctrineTopicId } from './types.js';

// The doctrine the coach prescribes from, in curriculum order: general
// principles first, then the capacities in the order they are built
// (aerobic base, periodization, strength, climbing), then the constraints
// every phase respects (recovery, mobility), then this athlete's own ideal.
// The order is the index order the coach sees, so it is fixed here.
export const DOCTRINE_TOPICS: readonly DoctrineTopic[] = [
  PRINCIPLES,
  AEROBIC_BASE,
  PERIODIZATION,
  STRENGTH,
  CLIMBING,
  RECOVERY,
  MOBILITY,
  ATHLETE_IDEAL,
];

const TOPIC_IDS: readonly DoctrineTopicId[] = DOCTRINE_TOPICS.map(t => t.id);

const byId = new Map<string, DoctrineTopic>(DOCTRINE_TOPICS.map(t => [t.id, t]));

// The compact block the prompt carries: the coach's stance in one line, one
// line per topic, and the instruction that fetches the full text. It stays
// small because it rides on every request; the full text is read on demand.
export const DOCTRINE_INDEX: string = [
  'The coach prescribes one coherent method: aerobic base first, general strength before max strength before specific strength, structured periodization toward a named mountain objective, recovery and mobility as constraints on all of it. The full doctrine is available by topic:',
  ...DOCTRINE_TOPICS.map(t => `- ${t.id}: ${t.summary}`),
  'Use read_doctrine(topic) for the full text before programming a block, changing a phase, or answering a why-question.',
].join('\n');

/** The full text of one topic, or null for an id that is not a topic. */
export function readDoctrine(topic: string): string | null {
  return byId.get(topic)?.text ?? null;
}

/** Every topic as a citation document: title plus full text, in index order. */
export function doctrineDocuments(): Array<{ title: string; text: string }> {
  return DOCTRINE_TOPICS.map(t => ({ title: t.title, text: t.text }));
}

export const readDoctrineToolSchema: Anthropic.Tool = {
  name: 'read_doctrine',
  description:
    'Read the full text of one topic of the training doctrine the coach prescribes from. ' +
    'Call it before programming a training block, before moving an athlete between phases, ' +
    'before prescribing strength, climbing-specific, aerobic or recovery work you have not read the doctrine on in this conversation, ' +
    'and whenever the athlete asks why a prescription is what it is. ' +
    'Each topic ends with sections the coach applies directly and signals that should make it question the prescription; cite those lines when explaining a decision. ' +
    'The index in the system prompt lists the topics; read one topic per call.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: [...TOPIC_IDS],
        description: 'The doctrine topic to read, by its id from the index.',
      },
    },
    required: ['topic'],
    additionalProperties: false,
  },
};
