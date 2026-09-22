import Anthropic from '@anthropic-ai/sdk';

// One place that decides how long the API is willing to wait on Anthropic,
// and how often it retries. Every call site was `new Anthropic({ apiKey })`
// — the SDK's defaults, which include a 10-minute timeout: on a serverless
// function that is not a timeout at all, it is "hang until the platform kills
// the invocation".
//
// WHAT `timeout` ACTUALLY BOUNDS
// It is per ATTEMPT, not per call. For a streaming request it bounds
// time-to-HEADERS only — the response headers arrive before the model has
// generated anything, so a long thinking turn is never cut short by it, while
// a connect that hangs (DNS, a dead socket, an upstream that accepts and then
// says nothing) is caught in 20s instead of ten minutes.
//
// WHY 20s × 2 ATTEMPTS
// `maxRetries: 1` means one retry, so the worst case is two attempts of 20s
// = 40s, inside the 60s `maxDuration` that vercel.json gives api/chat.ts.
// The SDK's default is `maxRetries: 2` (three attempts, 60s of headers
// alone), which would leave nothing for the stream itself — so the retry half
// of this is a deliberate reduction, not an inherited default.
//
// WHAT THIS DOES NOT COVER
// A stream that dies MID-BODY, after headers. The SDK does not retry that
// (the eval harness retries such streams itself for exactly this reason —
// evals/src/harness.ts:114-117), and neither does this client: the coach is
// mid-response with bytes already on the wire, and api/chat.ts's
// abort-on-disconnect must stay the thing that ends it.

/** The shared Anthropic client construction — see the note above. */
export function makeAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
}
