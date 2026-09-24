import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { helpMarkdownViolations, parseLegalMarkdown } from '../../legal/markdown';
import { HELP_PAGES } from '../pages';

// Every page Apex links to from a tip, the intro or Profile. A listed slug
// without a file, a title that drifted from pages.ts, a screenshot that was
// never generated, or a stale PNG nobody references fails here rather than
// in front of a new user. Format and conventions: help/README.md.

const ROOT = join(import.meta.dirname, '../../../..');
const HELP_DIR = join(ROOT, 'help');
const PUBLIC_DIR = join(ROOT, 'public');

const IMAGE_LINE_RE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;
const EXTERNAL_RE = /^<!--\s*EXTERNAL:/;

interface ImageRef { src: string; line: number; external: boolean }

/**
 * Images referenced by the RAW source — the parser strips comments, and the
 * `<!-- EXTERNAL: ... -->` placeholder that excuses a missing file is one.
 * It only counts on the line directly above the image.
 */
function imageRefs(source: string): ImageRef[] {
  const lines = source.split(/\r?\n/);
  const refs: ImageRef[] = [];
  lines.forEach((line, idx) => {
    const m = IMAGE_LINE_RE.exec(line.trim());
    if (!m) return;
    refs.push({ src: m[1], line: idx + 1, external: EXTERNAL_RE.test(lines[idx - 1]?.trim() ?? '') });
  });
  return refs;
}

describe.each(HELP_PAGES.map(p => ({ ...p })))('help/$slug.md', ({ slug, title }) => {
  const file = join(HELP_DIR, `${slug}.md`);
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';

  it('exists', () => {
    expect(existsSync(file), `help/${slug}.md`).toBe(true);
  });

  it('opens with a # heading equal to its pages.ts title', () => {
    const first = source.split(/\r?\n/).find(l => /^#\s/.test(l));
    expect(first?.replace(/^#\s+/, '').trim()).toBe(title);
  });

  it('uses only the markdown subset the renderer implements', () => {
    expect(helpMarkdownViolations(source, slug)).toEqual([]);
  });

  it('carries no comment into the parsed output', () => {
    const parsed = JSON.stringify(parseLegalMarkdown(source));
    expect(parsed).not.toContain('<!--');
    expect(parsed).not.toContain('EXTERNAL:');
  });

  it('has every referenced screenshot on disk, unless it is marked EXTERNAL', () => {
    const missing = imageRefs(source)
      .filter(ref => !ref.external && !existsSync(join(PUBLIC_DIR, ref.src)))
      .map(ref => `line ${ref.line}: ${ref.src}`);
    expect(missing, 'generate them with e2e/shots/<slug>.shots.ts').toEqual([]);
  });

  it('references every screenshot in its directory', () => {
    const dir = join(PUBLIC_DIR, 'help', slug);
    const onDisk = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')) : [];
    const referenced = new Set(imageRefs(source).map(ref => ref.src));
    const orphans = onDisk.filter(f => !referenced.has(`/help/${slug}/${f}`));
    expect(orphans, `unreferenced PNGs in public/help/${slug}/`).toEqual([]);
  });
});

describe('the help directory and pages.ts agree', () => {
  const slugs = HELP_PAGES.map(p => p.slug as string);

  it('every help/*.md is a listed page', () => {
    const pages = readdirSync(HELP_DIR)
      .filter(f => f.endsWith('.md') && f !== 'README.md')
      .map(f => f.replace(/\.md$/, ''));
    expect(pages.filter(p => !slugs.includes(p))).toEqual([]);
  });

  it('every public/help/ directory belongs to a listed page', () => {
    const dirs = readdirSync(join(PUBLIC_DIR, 'help'), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    expect(dirs.filter(d => !slugs.includes(d))).toEqual([]);
  });

  it('slugs are unique', () => {
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('the EXTERNAL placeholder rule', () => {
  it('excuses an image only when the comment is directly above it', () => {
    const refs = imageRefs([
      '<!-- EXTERNAL: https://console.anthropic.com — keys page -->',
      '![Keys](/help/get-api-key/01-keys.desktop.png)',
      '',
      '<!-- EXTERNAL: https://console.anthropic.com — too far away -->',
      '',
      '![Billing](/help/get-api-key/02-billing.desktop.png)',
    ].join('\n'));
    expect(refs.map(r => r.external)).toEqual([true, false]);
  });
});
