// The cycle preview endpoint, mocked for the driven profile.
//
// Since W10 the web's cycle editor previews through `POST /api/blocks?
// resource=cycle` instead of running cadence.ts in the browser, so the mock
// suite has to answer it. As with analytics.mjs, the stub runs the app's OWN
// pure functions — generateCycle, overlapsExisting, blockToRow — over the
// posted spec: there is no second cadence to drift from the real server, and
// a refusal a spec asserts on ("A cycle needs a name") is the real text.
//
// The intercept layer stubs training_blocks as empty, so the overlap check
// runs against nothing and `conflict` is always null here.

import {
  cycleTotalWeeks,
  generateCycle,
  isCycleSpecError,
  overlapsExisting,
} from '../../../src/lib/blocks/cadence.ts';
import { isValidationError } from '../../../src/lib/blocks/validate.ts';
import { blockToRow } from '../../../src/lib/blocks/mapping.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

const text = (route, body, status) =>
  route.fulfill({ status, contentType: 'text/plain', headers: CORS, body });

/** Mirrors api/_lib/handlers/blockCycle.ts. */
export function cyclePreviewRoute(route, req) {
  const { spec } = req.postDataJSON() ?? {};
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return text(route, 'spec must be an object', 400);
  try {
    const blocks = generateCycle(spec);
    return json(route, {
      ok: true,
      blocks,
      rows: blocks.map(blockToRow),
      totalWeeks: cycleTotalWeeks(spec),
      conflict: overlapsExisting(blocks, []),
    });
  } catch (err) {
    if (isCycleSpecError(err) || isValidationError(err)) return json(route, { ok: false, problem: err.message });
    return text(route, 'spec is not a cycle spec', 400);
  }
}
