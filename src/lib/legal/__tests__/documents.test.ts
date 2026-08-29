import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { legalMarkdownViolations, parseLegalMarkdown, splitFrontmatter } from '../markdown';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, PRIVACY_VERSION, TERMS_VERSION, needsAcceptance } from '../versions';

// The documents in /legal are the thing users actually agree to, and
// versions.ts is what the acceptance records and the API gate compare
// against. If those two ever disagree, an acceptance row would name a
// version nobody published. These tests are the pin.

const ROOT = join(import.meta.dirname, '../../../..');
const read = (version: string) => readFileSync(join(ROOT, 'legal', `${version}.md`), 'utf8');

const DOCS = [
  { label: 'terms', version: TERMS_VERSION, source: read(TERMS_VERSION) },
  { label: 'privacy', version: PRIVACY_VERSION, source: read(PRIVACY_VERSION) },
];

describe.each(DOCS)('legal/$version.md', ({ version, source }) => {
  it('has frontmatter matching its filename and versions.ts', () => {
    const { meta } = splitFrontmatter(source);
    expect(meta.version).toBe(version);
    expect(meta.effective).toBe(LEGAL_EFFECTIVE_DATE);
    expect(meta.title).toBeTruthy();
  });

  it('uses only the markdown subset the renderer implements', () => {
    expect(legalMarkdownViolations(source)).toEqual([]);
  });

  it('parses into blocks and renders no empty document', () => {
    const doc = parseLegalMarkdown(source);
    expect(doc.blocks.length).toBeGreaterThan(20);
    expect(doc.blocks[0]).toMatchObject({ type: 'heading', level: 1 });
  });

  it('carries no LEGAL REVIEW annotation into the parsed output', () => {
    expect(source).toContain('LEGAL REVIEW');           // the flags exist...
    const doc = parseLegalMarkdown(source);
    expect(JSON.stringify(doc)).not.toContain('LEGAL REVIEW'); // ...and never render
  });

  it('keeps its placeholders unresolved — no invented entity or jurisdiction', () => {
    const doc = JSON.stringify(parseLegalMarkdown(source));
    expect(doc).toContain('[LEGAL_ENTITY]');
    // A real company name must never be substituted in by accident.
    expect(doc).not.toMatch(/\bLLC\b|\bInc\.|\bCorporation\b/);
  });
});

describe('the documents make the disclosures the audit requires', () => {
  const terms = DOCS[0].source;
  const privacy = DOCS[1].source;

  it('the terms disclaim medical advice and AI output, and cover assumption of risk', () => {
    expect(terms).toContain('NOT A MEDICAL DEVICE');
    expect(terms).toContain('MACHINE-GENERATED');
    expect(terms).toContain('ASSUMPTION OF RISK');
    expect(terms).toContain('CONSULT A PHYSICIAN');
  });

  it('the terms disclaim warranties and limit liability conspicuously', () => {
    expect(terms).toContain('DISCLAIMER OF WARRANTIES');
    expect(terms).toContain('LIMITATION OF LIABILITY');
    expect(terms).toContain('AS IS');
  });

  it('the terms cover MCP access, ownership, termination, and governing law', () => {
    expect(terms).toContain('/api/mcp');
    expect(terms).toContain('[GOVERNING_STATE]');
    expect(terms).toContain(TERMS_VERSION);
  });

  it('the privacy policy names every third party the audit found', () => {
    for (const party of ['Anthropic', 'Vercel', 'Supabase', 'Gmail', 'COROS']) {
      expect(privacy).toContain(party);
    }
  });

  it('the privacy policy discloses the health and location data COROS brings', () => {
    expect(privacy).toContain('heart-rate variability');
    expect(privacy).toContain('VO2 max');
    expect(privacy).toContain('GPS track');
  });

  it('the privacy policy discloses the non-rotatable calendar feed token', () => {
    expect(privacy).toContain('cannot currently be rotated');
  });

  it('the privacy policy discloses that MCP tokens never expire', () => {
    expect(privacy).toContain('do not expire');
  });
});

describe('needsAcceptance', () => {
  it('is true with no record at all', () => {
    expect(needsAcceptance(null)).toBe(true);
    expect(needsAcceptance(undefined)).toBe(true);
  });

  it('is false only when both stored versions are current', () => {
    expect(needsAcceptance({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION })).toBe(false);
    expect(needsAcceptance({ termsVersion: 'terms-v0', privacyVersion: PRIVACY_VERSION })).toBe(true);
    expect(needsAcceptance({ termsVersion: TERMS_VERSION, privacyVersion: 'privacy-v0' })).toBe(true);
  });
});

describe('LEGAL_DOCUMENTS', () => {
  it('routes each document at a distinct top-level path', () => {
    const paths = LEGAL_DOCUMENTS.map(d => d.path);
    expect(paths).toEqual(['/terms', '/privacy']);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('a file exists on disk for every listed version', () => {
    for (const doc of LEGAL_DOCUMENTS) expect(read(doc.version).length).toBeGreaterThan(0);
  });
});
