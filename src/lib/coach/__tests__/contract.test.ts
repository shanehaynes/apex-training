import { describe, it, expect } from 'vitest';
import {
  CONTRACT_MAX, contractProblem, contractsEqual, isReflectionResolution, normalizeContract, reflectionAwaitsAthlete,
} from '../contract';

describe('normalizeContract', () => {
  it('trims, normalizes line endings, strips trailing spaces and collapses blank runs', () => {
    expect(normalizeContract('  Push me on volume.  \r\n\r\n\r\n\r\nLeave nutrition alone.   \n')).toBe('Push me on volume.\n\nLeave nutrition alone.');
    expect(normalizeContract('one\r\ntwo')).toBe('one\ntwo');
  });

  it('reads anything that is not a string, and whitespace, as no contract', () => {
    expect(normalizeContract(undefined)).toBe('');
    expect(normalizeContract(null)).toBe('');
    expect(normalizeContract(42)).toBe('');
    expect(normalizeContract('   \n  ')).toBe('');
  });
});

describe('contractProblem', () => {
  it('accepts a bounded string, including empty (a clear)', () => {
    expect(contractProblem('')).toBeNull();
    expect(contractProblem('Be blunt.')).toBeNull();
    expect(contractProblem('x'.repeat(CONTRACT_MAX))).toBeNull();
  });

  it('names the reason for a non-string or a text over the column limit', () => {
    expect(contractProblem(null)).toMatch(/must be a string/);
    expect(contractProblem('x'.repeat(CONTRACT_MAX + 1))).toMatch(new RegExp(`at most ${CONTRACT_MAX}`));
    // The bound is measured after normalization, so padding does not count.
    expect(contractProblem(`${'x'.repeat(CONTRACT_MAX)}   \n\n`)).toBeNull();
  });
});

describe('contractsEqual', () => {
  it('ignores whitespace and wrapping differences, nothing else', () => {
    expect(contractsEqual('Push me on\nvolume.', 'Push me on volume.')).toBe(true);
    expect(contractsEqual('  a  b  ', 'a b')).toBe(true);
    expect(contractsEqual('', null)).toBe(true);
    expect(contractsEqual('Push me.', 'push me.')).toBe(false);
    expect(contractsEqual('a', '')).toBe(false);
  });
});

describe('resolutions and rows', () => {
  it('accepts exactly accepted|rejected', () => {
    expect(isReflectionResolution('accepted')).toBe(true);
    expect(isReflectionResolution('rejected')).toBe(true);
    expect(isReflectionResolution('maybe')).toBe(false);
    expect(isReflectionResolution(null)).toBe(false);
  });

  it('a row awaits the athlete only when done, with a contract edit, and unresolved', () => {
    expect(reflectionAwaitsAthlete({ status: 'done', contract_after: 'x', resolved_at: null })).toBe(true);
    expect(reflectionAwaitsAthlete({ status: 'done', contract_after: null, resolved_at: null })).toBe(false);
    expect(reflectionAwaitsAthlete({ status: 'done', contract_after: 'x', resolved_at: '2026-09-28T05:00:00Z' })).toBe(false);
    expect(reflectionAwaitsAthlete({ status: 'failed', contract_after: 'x', resolved_at: null })).toBe(false);
  });
});
