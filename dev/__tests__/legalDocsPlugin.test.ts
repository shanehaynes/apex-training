import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import legalDocsPlugin from '../legalDocsPlugin.ts';

// Guards the strip that keeps `<!-- LEGAL REVIEW -->` questions out of the
// production bundle. The runtime strip in src/lib/legal/markdown.ts only
// keeps them off the rendered page — `?raw` would otherwise inline the
// original bytes into a JS chunk, where anyone could read them.

const ROOT = join(import.meta.dirname, '../..');
const plugin = legalDocsPlugin();
const load = (id: string) => (plugin.load as (this: unknown, id: string) => string | null).call(null, id);

describe('legalDocsPlugin', () => {
  it('strips LEGAL REVIEW comments out of a legal document', () => {
    const out = load(join(ROOT, 'legal/terms-v1.md') + '?raw');
    expect(out).toBeTruthy();
    expect(out).not.toContain('LEGAL REVIEW');
    expect(out).not.toContain('<!--');
  });

  it('still emits the document body', () => {
    const out = load(join(ROOT, 'legal/privacy-v1.md') + '?raw')!;
    expect(out).toContain('Privacy Policy');
    expect(out.startsWith('export default "')).toBe(true);
  });

  it('ignores files it does not own', () => {
    expect(load(join(ROOT, 'README.md') + '?raw')).toBeNull();
    expect(load(join(ROOT, 'legal/terms-v1.md'))).toBeNull();
    expect(load(join(ROOT, 'src/App.tsx'))).toBeNull();
  });
});
