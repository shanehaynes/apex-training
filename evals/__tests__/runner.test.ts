import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { buildRunResult, writeRunResult } from '../src/report';
import { evalOauthToken } from '../src/models';
import type { CaseResult } from '../src/types';

// Runner plumbing the backend seam added: which backend a result file records,
// where --out puts it, and how the subscription credential is found.

const CASE: CaseResult = {
  id: 'c1', verdicts: {}, turns: 1, toolCallCount: 0, anomalies: [],
  usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, latencyMs: 1000,
  transcriptHash: 'abc', transcriptPath: '/tmp/x.json',
};

describe('buildRunResult', () => {
  it('records which backend drove the coach', () => {
    expect(buildRunResult('claude-sonnet-5', 'claude-sonnet-5', 'agent-sdk', [CASE]).backend)
      .toBe('agent-sdk');
    expect(buildRunResult('claude-sonnet-5', 'claude-sonnet-5', 'api', [CASE]).backend)
      .toBe('api');
  });
});

describe('writeRunResult', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-out-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('--out names the file, creating the directory it sits in', () => {
    const run = buildRunResult('claude-sonnet-5', 'claude-sonnet-5', 'agent-sdk', [CASE]);
    const target = join(dir, 'nested', 'mine.json');
    expect(writeRunResult(run, target)).toBe(target);
    const written = JSON.parse(readFileSync(target, 'utf8'));
    expect(written.backend).toBe('agent-sdk');
    expect(written.cases).toHaveLength(1);
  });
});

describe('evalOauthToken', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eval-oat-'));
    saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  });

  it('prefers the shell environment over .env.local', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-from-env';
    writeFileSync(join(root, '.env.local'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-from-file\n');
    expect(evalOauthToken(root)).toBe('oat-from-env');
  });

  it('falls back to the .env.local line', () => {
    writeFileSync(join(root, '.env.local'), 'SEED_SOURCE_USER_ID=x\nCLAUDE_CODE_OAUTH_TOKEN=oat-from-file\n');
    expect(evalOauthToken(root)).toBe('oat-from-file');
  });

  it('falls through to the primary checkout from a worktree', () => {
    writeFileSync(join(root, '.env.local'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-from-primary\n');
    const worktree = join(root, '.claude', 'worktrees', 'feat-thing');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'feat-thing')}\n`);
    expect(evalOauthToken(worktree)).toBe('oat-from-primary');
  });

  it('is undefined when neither source has it', () => {
    writeFileSync(join(root, '.env.local'), 'SEED_SOURCE_USER_ID=x\n');
    expect(evalOauthToken(root)).toBeUndefined();
  });

  // A `claude setup-token` value pasted into .env.local is long enough that a
  // terminal may fold it. Loading the first 80 characters as if they were the
  // whole token produces an auth failure with nothing pointing at the cause.
  it('refuses a value wrapped across two lines instead of truncating it', () => {
    writeFileSync(join(root, '.env.local'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-firsthalf\nsecondhalf\n');
    expect(() => evalOauthToken(root)).toThrow(/wrapped across two lines/);
  });

  it('surfaces a wrapped value in the PRIMARY checkout, not just the worktree', () => {
    writeFileSync(join(root, '.env.local'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-firsthalf\nsecondhalf\n');
    const worktree = join(root, '.claude', 'worktrees', 'feat-thing');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'feat-thing')}\n`);
    expect(() => evalOauthToken(worktree)).toThrow(/wrapped across two lines/);
  });

  it('does not mistake the next KEY= line, or a comment, for a continuation', () => {
    writeFileSync(join(root, '.env.local'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-ok\n# trailing note\nOTHER=1\n');
    expect(evalOauthToken(root)).toBe('oat-ok');
  });
});
