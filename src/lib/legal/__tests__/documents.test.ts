import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { legalMarkdownViolations, parseLegalMarkdown, splitFrontmatter, type Block, type Inline } from '../markdown';
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

/** The text a reader sees, one line per paragraph, list item or table cell.
 *  Inline runs are joined without separators, so bold or code in the middle
 *  of a sentence cannot split a phrase the pins below look for. */
const inlineText = (inlines: Inline[]) => inlines.map(i => i.text).join('');
function blockLines(b: Block): string[] {
  switch (b.type) {
    case 'heading': case 'paragraph': return [inlineText(b.inlines)];
    case 'list': return b.items.map(inlineText);
    case 'table': return [...b.head, ...b.rows.flat()].map(inlineText);
    case 'image': return [b.alt];
    case 'rule': return [];
  }
}
function shown(source: string): string {
  return parseLegalMarkdown(source).blocks.flatMap(blockLines).join('\n');
}

/** Rendered text per top-level section ("## N. …"), keyed by N; 0 is the preamble. */
function sections(source: string): Map<number, string> {
  const out = new Map<number, string>();
  let current = 0;
  for (const block of parseLegalMarkdown(source).blocks) {
    if (block.type === 'heading' && block.level === 2) {
      const n = Number(inlineText(block.inlines).match(/^(\d+)\./)?.[1]);
      if (n) current = n;
    }
    out.set(current, [out.get(current), ...blockLines(block)].join('\n'));
  }
  return out;
}

describe.each(DOCS)('legal/$version.md', ({ version, source }) => {
  it('has frontmatter matching its filename and versions.ts', () => {
    const { meta } = splitFrontmatter(source);
    expect(meta.version).toBe(version);
    expect(meta.effective).toBe(LEGAL_EFFECTIVE_DATE);
    expect(meta.title).toBeTruthy();
  });

  it('states the same version and date in the header a reader sees', () => {
    expect(source).toContain(`**Version ${version} · Effective ${LEGAL_EFFECTIVE_DATE}**`);
  });

  it('a bumped document says what changed from the version before it', () => {
    // An athlete asked to accept again should not have to diff two documents
    // to learn why.
    const n = Number(version.match(/-v(\d+)$/)![1]);
    if (n > 1) {
      const previous = version.replace(/\d+$/, String(n - 1));
      expect(shown(source)).toContain(`What changed from ${previous}`);
    }
  });

  it('and names every section whose text changed, so "Nothing else changed" is true', () => {
    const n = Number(version.match(/-v(\d+)$/)![1]);
    if (n <= 1) return;
    const previous = version.replace(/\d+$/, String(n - 1));
    // The version identifier itself is not a change worth listing.
    const before = sections(read(previous).replaceAll(previous, version));
    const after = sections(source);
    const changed = [...after.keys()].filter(k => k > 0 && after.get(k) !== before.get(k));

    const text = shown(source);
    const summary = text.slice(text.indexOf(`What changed from ${previous}`), text.indexOf('Nothing else in'));
    const named = new Set([...summary.matchAll(/sections?\s+(\d+(?:\.\d+)?(?:(?:\s*,\s*|\s+and\s+)\d+(?:\.\d+)?)*)/gi)]
      .flatMap(m => m[1].split(/\s*,\s*|\s+and\s+/).map(s => Math.trunc(Number(s)))));
    expect(changed.length, 'no section changed: is the previous version readable?').toBeGreaterThan(0);
    expect(changed.filter(k => !named.has(k)), `sections changed since ${previous} but not named`).toEqual([]);
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
    for (const party of ['Anthropic', 'Vercel', 'Supabase', 'Resend', 'Cloudflare', 'COROS']) {
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

  it('the documents disclose what MCP access grants: expiry, write access, and the activity log', () => {
    // Personal access tokens expire after a year (api/_lib/handlers/mcpTokens.ts)
    // and a token or connection can carry write access (PR #371); both
    // documents say so, and neither still promises a read-only endpoint.
    // The markdown is hard-wrapped, so a phrase may break across a line.
    for (const doc of [terms, privacy]) {
      expect(doc).toMatch(/write\s+access/);
      expect(doc).toMatch(/activity\s+log/);
      expect(doc).toContain('200');
      expect(doc).not.toMatch(/read-only\s+endpoint|endpoint\s+is\s+read-only|do\s+not\s+expire/);
    }
    expect(privacy).toMatch(/expire\s+after\s+one\s+year/);
    expect(terms).toMatch(/one\s+year/);
  });

  it('the documents describe open sign-up: no invitation-only claim, the bot check, the 18+ box', () => {
    // Sign-up opened 2026-10-17 (#452) with Cloudflare Turnstile on the form
    // (TurnstileWidget.tsx) and, from #477, an 18+ box stamped as
    // age_confirmed_at. Checked on the rendered text: the LEGAL REVIEW notes
    // quote the old wording on purpose.
    expect(shown(terms)).not.toMatch(/Accounts\s+are\s+currently\s+created\s+by\s+invitation/);
    expect(shown(privacy)).not.toMatch(/third-party\s+scripts\s+of\s+any\s+kind/);
    expect(shown(privacy)).not.toMatch(/sell\s+or\s+share\s+your\s+data/);
    expect(shown(privacy)).toContain('Turnstile');
    expect(shown(privacy)).toMatch(/18\s+or\s+older/);
  });

  it('the privacy policy describes what the coach keeps, for as long as the export carries it', () => {
    // privacy-v1 said coach chat was not stored; the web has saved threads
    // since phase46 (#303), then memory, calendar notes and reflections.
    // The export (account.ts) lists every table it reads, so it is the pin.
    const account = readFileSync(join(ROOT, 'api/_lib/handlers/account.ts'), 'utf8');
    // Up to `] as const`, so a bracket in a comment cannot end the list early;
    // a spread would hide names from this read, so it fails instead.
    const list = account.match(/export const USER_DATA_TABLES = \[([\s\S]*?)\] as const/)?.[1] ?? '';
    expect(list, 'USER_DATA_TABLES must stay a literal list').not.toContain('...');
    const coachTables = [...list.matchAll(/['"`](\w+)['"`]/g)].map(m => m[1]).filter(t => t.startsWith('coach_'));
    expect(coachTables.length, 'USER_DATA_TABLES not found or holds no coach table').toBeGreaterThan(0);
    for (const table of coachTables) expect(shown(privacy), table).toContain(table);
    expect(shown(privacy)).not.toMatch(/not\s+stored\s+on\s+our\s+servers/);
  });

  it('the privacy policy names Google Fonts while the stylesheet loads it', () => {
    // src/styles/tokens.css imports Google Fonts on every page, so Google
    // receives every visitor's IP address. Self-hosting the fonts retires both.
    const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');
    if (tokens.includes('fonts.googleapis.com')) {
      expect(shown(privacy)).toContain('fonts.googleapis.com');
    }
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

// e2e/lib/intercept.mjs cannot import these constants (plain .mjs, imported
// by node from scripts/drive.mjs), so it hardcodes them. This is the pin: a
// version bump that forgets the stub would otherwise leave every mock spec
// blocked behind the acceptance modal, failing them all at once for a reason
// none of their names would suggest.
describe('the mock e2e intercept stub tracks the current versions', () => {
  const intercept = readFileSync(join(ROOT, 'e2e/lib/intercept.mjs'), 'utf8');

  it('stubs the current terms version', () => {
    expect(intercept).toContain(`termsVersion: '${TERMS_VERSION}'`);
  });

  it('stubs the current privacy version', () => {
    expect(intercept).toContain(`privacyVersion: '${PRIVACY_VERSION}'`);
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

  it('the pages bundle the current files', () => {
    // Static ?raw imports cannot be built from the constants, so a bump edits
    // them by hand; this is what catches one that forgets.
    const page = readFileSync(join(ROOT, 'src/components/legal/LegalPage.tsx'), 'utf8');
    for (const doc of LEGAL_DOCUMENTS) {
      const bound = page.match(new RegExp(`^import ${doc.slug}Source from '[^']*/legal/([\\w-]+)\\.md\\?raw';$`, 'm'));
      expect(bound?.[1], `${doc.slug}Source must import legal/${doc.version}.md`).toBe(doc.version);
    }
  });
});

// Every acceptance row names a version. Once a version is superseded its file
// is the record of what those rows agreed to, so it is kept, byte for byte.
// Add each document here when a bump supersedes it.
const SUPERSEDED: Record<string, string> = {
  'terms-v1': 'ef6c2bfb59a44b439f1bb0b7beb73fbce07d88523d0c5f7e2199155faba5cf4f',
  'privacy-v1': '955c31b7347d8347bfcb41cb63d87306d4722804ff2979a32cd47bd095300b99',
};

describe('superseded versions', () => {
  it('every earlier version of a current document is listed', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const n = Number(doc.version.match(/-v(\d+)$/)![1]);
      for (let k = 1; k < n; k++) expect(Object.keys(SUPERSEDED)).toContain(`${doc.slug}-v${k}`);
    }
  });

  it.each(Object.entries(SUPERSEDED))('legal/%s.md is unchanged since it was superseded', (version, sha256) => {
    const source = read(version);
    expect(splitFrontmatter(source).meta.version).toBe(version);
    expect(createHash('sha256').update(source).digest('hex')).toBe(sha256);
  });
});
