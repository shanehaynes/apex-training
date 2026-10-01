import { isMemoryKind, MEMORY_CONTENT_MAX, MEMORY_KINDS, type MemoryKind } from '../../../src/lib/coach/memory.js';
import { CONTRACT_MAX, normalizeContract } from '../../../src/lib/coach/contract.js';

// The reflection's output, parsed STRICTLY (lane D01): the shape the system
// prompt asks for, and nothing looser. A reply that is not that shape is a
// parse failure the cron retries once with the reason, then records on the
// row as `failed` — never a half-applied proposal. Pure.

export interface MemoryProposal {
  kind: MemoryKind;
  content: string;
  /** In (0, 1]: the model's own estimate that the athlete will confirm it. */
  confidence: number;
  why: string;
}

export interface ContractProposal {
  after: string;
  reason: string;
}

export interface ReflectionOutput {
  memories: MemoryProposal[];
  contract: ContractProposal | null;
}

export type ParseResult =
  | { ok: true; value: ReflectionOutput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in a reply: the text as is, or the body of one ```json fence. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

function parseMemory(raw: unknown, i: number): MemoryProposal | string {
  if (!isRecord(raw)) return `memories[${i}] is not an object`;
  if (!isMemoryKind(raw.kind)) return `memories[${i}].kind must be one of ${MEMORY_KINDS.join(', ')}`;
  const content = typeof raw.content === 'string' ? raw.content.replace(/\s+/g, ' ').trim() : '';
  if (!content) return `memories[${i}].content must be a non-empty string`;
  if (content.length > MEMORY_CONTENT_MAX) return `memories[${i}].content must be at most ${MEMORY_CONTENT_MAX} characters`;
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence <= 0 || confidence > 1) {
    return `memories[${i}].confidence must be a number in (0, 1]`;
  }
  const why = typeof raw.why === 'string' ? raw.why.replace(/\s+/g, ' ').trim() : '';
  return { kind: raw.kind, content, confidence, why };
}

function parseContract(raw: unknown): ContractProposal | null | string {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return 'contract must be an object or null';
  const after = normalizeContract(raw.after);
  if (!after) return 'contract.after must be a non-empty string';
  if (after.length > CONTRACT_MAX) return `contract.after must be at most ${CONTRACT_MAX} characters`;
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim() : '';
  if (!reason) return 'contract.reason must be a non-empty string';
  return { after, reason };
}

/**
 * Parse one reply. The error text is written for the model: it goes back
 * verbatim in the one retry.
 */
export function parseReflectionOutput(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'the reply must be one JSON object' };
  if (!Array.isArray(parsed.memories)) return { ok: false, error: 'memories must be an array' };
  const memories: MemoryProposal[] = [];
  for (const [i, raw] of parsed.memories.entries()) {
    const m = parseMemory(raw, i);
    if (typeof m === 'string') return { ok: false, error: m };
    memories.push(m);
  }
  if (!('contract' in parsed)) return { ok: false, error: 'contract must be present (an object or null)' };
  const contract = parseContract(parsed.contract);
  if (typeof contract === 'string') return { ok: false, error: contract };
  return { ok: true, value: { memories, contract } };
}
