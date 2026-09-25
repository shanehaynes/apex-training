import { describe, it, expect } from 'vitest';
import {
  DOCTRINE_INDEX,
  DOCTRINE_TOPICS,
  doctrineDocuments,
  readDoctrine,
  readDoctrineToolSchema,
} from '../index';

const EXPECTED_ORDER = [
  'principles',
  'aerobic-base',
  'periodization',
  'strength',
  'climbing',
  'recovery',
  'mobility',
  'athlete-ideal',
];

// Budgets: the whole set rides through the coach's context on demand (a
// chars/4 estimate of ~20k tokens), the index rides on every request.
const TOTAL_TEXT_MAX = 80_000;
const INDEX_MAX = 4_000;
const TOPIC_MIN = 6_000;
const TOPIC_MAX = 16_000;

describe('doctrine topics', () => {
  it('are in the fixed curriculum order with unique ids', () => {
    const ids = DOCTRINE_TOPICS.map(t => t.id);
    expect(ids).toEqual(EXPECTED_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('have non-empty titles, one-sentence summaries and text', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(t.title.trim().length, t.id).toBeGreaterThan(0);
      expect(t.summary.trim().length, t.id).toBeGreaterThan(0);
      expect(t.summary.trim().endsWith('.'), `${t.id} summary ends with a period`).toBe(true);
      expect(t.text.trim().length, t.id).toBeGreaterThan(0);
    }
  });

  it('each contain the two sections citations land on', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(t.text, t.id).toContain('How the coach applies this');
      expect(t.text, t.id).toContain('Signals that contradict this');
      // Applies-bullets precede the contradicting signals, and both close the topic.
      expect(t.text.indexOf('How the coach applies this'), t.id).toBeLessThan(t.text.indexOf('Signals that contradict this'));
    }
  });

  it('never contain angle brackets in title, summary or text', () => {
    for (const t of DOCTRINE_TOPICS) {
      for (const field of [t.title, t.summary, t.text]) {
        expect(field, t.id).not.toMatch(/[<>]/);
      }
    }
  });

  it('never contain template-literal interpolation or backticks in text', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(t.text, t.id).not.toContain('${');
      expect(t.text, t.id).not.toContain('`');
    }
  });
});

describe('doctrine budget', () => {
  it('keeps each topic between the per-topic bounds', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(t.text.length, `${t.id} is ${t.text.length} chars`).toBeGreaterThanOrEqual(TOPIC_MIN);
      expect(t.text.length, `${t.id} is ${t.text.length} chars`).toBeLessThan(TOPIC_MAX);
    }
  });

  it('keeps the whole set under the total budget', () => {
    const total = DOCTRINE_TOPICS.reduce((n, t) => n + t.text.length, 0);
    expect(total, `total is ${total} chars`).toBeLessThan(TOTAL_TEXT_MAX);
  });

  it('keeps the index under its budget', () => {
    expect(DOCTRINE_INDEX.length, `index is ${DOCTRINE_INDEX.length} chars`).toBeLessThan(INDEX_MAX);
  });
});

describe('DOCTRINE_INDEX', () => {
  it('names every topic with its summary and the read instruction', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(DOCTRINE_INDEX).toContain(`- ${t.id}: ${t.summary}`);
    }
    expect(DOCTRINE_INDEX).toContain('read_doctrine(topic)');
    expect(DOCTRINE_INDEX).not.toMatch(/[<>]/);
  });
});

describe('readDoctrine', () => {
  it('returns each topic text by id', () => {
    for (const t of DOCTRINE_TOPICS) {
      expect(readDoctrine(t.id)).toBe(t.text);
    }
  });

  it('returns null for an unknown id', () => {
    expect(readDoctrine('nutrition')).toBeNull();
    expect(readDoctrine('')).toBeNull();
    expect(readDoctrine('Principles')).toBeNull();
  });
});

describe('doctrineDocuments', () => {
  it('returns one citation document per topic, in index order', () => {
    const docs = doctrineDocuments();
    expect(docs.map(d => d.title)).toEqual(DOCTRINE_TOPICS.map(t => t.title));
    expect(docs.map(d => d.text)).toEqual(DOCTRINE_TOPICS.map(t => t.text));
  });
});

describe('readDoctrineToolSchema', () => {
  it('is named read_doctrine with a single required topic enum equal to the ids', () => {
    expect(readDoctrineToolSchema.name).toBe('read_doctrine');
    expect(readDoctrineToolSchema.description).toBeTruthy();
    const schema = readDoctrineToolSchema.input_schema as {
      type: string;
      properties: Record<string, { type: string; enum?: string[] }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['topic']);
    expect(schema.properties.topic.enum).toEqual(DOCTRINE_TOPICS.map(t => t.id));
    expect(schema.required).toEqual(['topic']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('accepts exactly the ids readDoctrine resolves', () => {
    const schema = readDoctrineToolSchema.input_schema as { properties: { topic: { enum: string[] } } };
    for (const id of schema.properties.topic.enum) {
      expect(readDoctrine(id), id).not.toBeNull();
    }
  });
});
