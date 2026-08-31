import type { EvalCase } from '../src/types';
import { CONSTRAINT_CASES } from './constraints';
import { PROGRESSION_CASES } from './progression';
import { REFUSAL_CASES } from './refusal';
import { INTEGRITY_CASES } from './integrity';
import { BUILDER_CASES } from './builder';
import { ANALYTICS_CASES } from './analytics';

export const ALL_CASES: EvalCase[] = [
  ...CONSTRAINT_CASES,
  ...PROGRESSION_CASES,
  ...REFUSAL_CASES,
  ...INTEGRITY_CASES,
  ...BUILDER_CASES,
  ...ANALYTICS_CASES,
];

const ids = new Set<string>();
for (const c of ALL_CASES) {
  if (ids.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
  ids.add(c.id);
}
