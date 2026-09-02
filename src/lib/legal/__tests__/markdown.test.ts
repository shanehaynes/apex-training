import { describe, it, expect } from 'vitest';
import {
  legalMarkdownViolations,
  parseInline,
  parseLegalMarkdown,
  splitFrontmatter,
  stripComments,
} from '../markdown';

describe('stripComments', () => {
  it('removes single-line HTML comments', () => {
    expect(stripComments('a <!-- gone --> b')).toBe('a  b');
  });

  it('removes comments that span lines', () => {
    const source = 'keep\n<!-- LEGAL REVIEW: a question\nspanning two lines -->\nkeep2';
    expect(stripComments(source)).not.toContain('LEGAL REVIEW');
    expect(stripComments(source)).toContain('keep2');
  });

  it('removes several comments in one document', () => {
    expect(stripComments('<!--a-->x<!--b-->y<!--c-->')).toBe('xy');
  });
});

describe('splitFrontmatter', () => {
  it('reads key/value pairs and returns the remaining body', () => {
    const { meta, body } = splitFrontmatter('---\nversion: terms-v1\ntitle: Terms\n---\n# Hi\n');
    expect(meta).toEqual({ version: 'terms-v1', title: 'Terms' });
    expect(body.trim()).toBe('# Hi');
  });

  it('passes a document without frontmatter through unchanged', () => {
    const { meta, body } = splitFrontmatter('# Hi');
    expect(meta).toEqual({});
    expect(body).toBe('# Hi');
  });
});

describe('parseInline', () => {
  it('parses strong, code, and links', () => {
    expect(parseInline('a **b** `c` [d](/e)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'd', href: '/e' },
    ]);
  });

  it('leaves an unmatched marker as literal text rather than throwing', () => {
    expect(parseInline('5 * 3 = 15')).toEqual([{ type: 'text', text: '5 * 3 = 15' }]);
  });
});

describe('parseLegalMarkdown', () => {
  it('parses headings, paragraphs, rules, and lists', () => {
    const doc = parseLegalMarkdown('## Two\n\ntext here\n\n---\n\n- one\n- two\n');
    expect(doc.blocks.map(b => b.type)).toEqual(['heading', 'paragraph', 'rule', 'list']);
    expect(doc.blocks[3]).toMatchObject({ type: 'list', ordered: false });
  });

  it('parses ordered lists separately from unordered', () => {
    const doc = parseLegalMarkdown('1. first\n2. second\n');
    expect(doc.blocks[0]).toMatchObject({ type: 'list', ordered: true });
    expect((doc.blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('joins an indented continuation line into its list item', () => {
    const doc = parseLegalMarkdown('- one line\n  wrapped here\n- two\n');
    const items = (doc.blocks[0] as { items: Array<Array<{ text: string }>> }).items;
    expect(items[0][0].text).toBe('one line wrapped here');
    expect(items).toHaveLength(2);
  });

  it('parses a pipe table with its header row', () => {
    const doc = parseLegalMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n');
    const table = doc.blocks[0] as { type: string; head: unknown[]; rows: unknown[] };
    expect(table.type).toBe('table');
    expect(table.head).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
  });

  it('does not treat a paragraph containing a pipe as a table', () => {
    const doc = parseLegalMarkdown('a | b is not a table\n');
    expect(doc.blocks[0].type).toBe('paragraph');
  });

  it('produces no block at all for a comment — the LEGAL REVIEW guarantee', () => {
    const doc = parseLegalMarkdown('# T\n\n<!-- LEGAL REVIEW: secret question -->\n\ntail\n');
    expect(JSON.stringify(doc)).not.toContain('LEGAL REVIEW');
    expect(JSON.stringify(doc)).not.toContain('secret question');
    expect(doc.blocks.map(b => b.type)).toEqual(['heading', 'paragraph']);
  });
});

describe('legalMarkdownViolations', () => {
  it('reports unsupported syntax', () => {
    expect(legalMarkdownViolations('> quote')).toHaveLength(1);
    expect(legalMarkdownViolations('![alt](x.png)')).toHaveLength(1);
    expect(legalMarkdownViolations('#### too deep')).toHaveLength(1);
    expect(legalMarkdownViolations('* bullet')).toHaveLength(1);
    expect(legalMarkdownViolations('```js')).toHaveLength(1);
  });

  it('ignores syntax inside a comment, which never renders', () => {
    expect(legalMarkdownViolations('<!-- > quote -->')).toEqual([]);
  });

  it('passes a document in the supported subset', () => {
    expect(legalMarkdownViolations('# H\n\n- a\n\n| A |\n| --- |\n| 1 |\n')).toEqual([]);
  });
});
