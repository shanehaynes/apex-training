// A deliberately small markdown parser for the two legal documents in
// /legal. It exists instead of a dependency because the input is not
// arbitrary markdown — it is two files we write ourselves, in a subset we
// control, and legalMarkdownViolations() below fails the build if either
// document drifts outside it.
//
// It returns a data structure rather than HTML or React, so this module stays
// dependency-free and unit-testable, and so the renderer never needs
// dangerouslySetInnerHTML: LegalPage.tsx maps blocks to elements and React
// escapes the text.
//
// THE ONE RULE THAT MATTERS: HTML comments are stripped before anything else
// is parsed. The documents carry `<!-- LEGAL REVIEW: ... -->` annotations
// addressed to a lawyer, and those must never reach a reader. There is no
// code path that renders a comment, because comments do not survive to
// become blocks at all.
//
// SUPPORTED SUBSET
//   frontmatter   --- key: value --- at the very top of the file
//   headings      #, ##, ### at line start
//   paragraphs    runs of text separated by blank lines
//   lists         lines starting "- " (unordered) or "1. " (ordered)
//   tables        pipe rows with a | --- | separator under the header
//   rule          a line of exactly ---
//   inline        **strong**, `code`, [text](href)
// Anything else — images, blockquotes, nested lists, setext headings, raw
// HTML — is unsupported and reported by legalMarkdownViolations().

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

export interface LegalDocument {
  meta: Record<string, string>;
  blocks: Block[];
}

/** Strip every HTML comment, including multi-line ones. Runs first, always. */
export function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/** Split leading `---` frontmatter from the body. Missing frontmatter is fine. */
export function splitFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

// One pass over the line, longest-match-first so `**bold**` is not mistaken
// for two emphasis runs. Unmatched markers stay literal text rather than
// throwing — a stray asterisk in a legal document should render, not 500.
const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'strong', text: m[1] });
    else if (m[2] !== undefined) out.push({ type: 'code', text: m[2] });
    else out.push({ type: 'link', text: m[3], href: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.length ? out : [{ type: 'text', text: '' }];
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^-\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const TABLE_DIVIDER_RE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

/** Split a pipe row into trimmed cells, dropping the leading/trailing pipes. */
function tableCells(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

export function parseLegalMarkdown(source: string): LegalDocument {
  const { meta, body } = splitFrontmatter(stripComments(source));
  const lines = body.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushParagraph(); continue; }

    if (trimmed === '---') { flushParagraph(); blocks.push({ type: 'rule' }); continue; }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseInline(heading[2]),
      });
      continue;
    }

    // A table is a header row whose NEXT line is the | --- | divider. Checking
    // the divider first keeps an ordinary paragraph containing a pipe from
    // being swallowed as a one-column table.
    if (trimmed.startsWith('|') && TABLE_DIVIDER_RE.test(lines[i + 1]?.trim() ?? '')) {
      flushParagraph();
      const head = tableCells(trimmed).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(tableCells(lines[i].trim()).map(parseInline));
        i++;
      }
      i--; // the loop's own i++ consumes the terminating line
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const ul = UL_RE.exec(trimmed);
    const ol = OL_RE.exec(trimmed);
    if (ul || ol) {
      flushParagraph();
      const ordered = !!ol;
      const items: string[] = [(ul ?? ol)![1]];
      // Continuation lines of a list item are indented; they join the item
      // rather than starting a paragraph.
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextTrimmed = next.trim();
        if (!nextTrimmed) break;
        const nextUl = UL_RE.exec(nextTrimmed);
        const nextOl = OL_RE.exec(nextTrimmed);
        if (ordered ? nextOl : nextUl) {
          items.push((nextOl ?? nextUl)![1]);
          i++;
        } else if (/^\s+/.test(next) && !nextUl && !nextOl) {
          items[items.length - 1] += ' ' + nextTrimmed;
          i++;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return { meta, blocks };
}

/**
 * Report lines that use markdown this parser does not implement. A test runs
 * this over both real documents, so a future edit reaching for a blockquote
 * or an image fails CI instead of silently rendering as literal text.
 */
export function legalMarkdownViolations(source: string): string[] {
  const { body } = splitFrontmatter(stripComments(source));
  const lines = body.split(/\r?\n/);
  const problems: string[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const at = `line ${idx + 1}: `;
    if (/^>/.test(trimmed)) problems.push(at + 'blockquotes are not supported');
    if (/^!\[/.test(trimmed)) problems.push(at + 'images are not supported');
    if (/^(?:```|~~~)/.test(trimmed)) problems.push(at + 'fenced code blocks are not supported');
    if (/^#{4,}\s/.test(trimmed)) problems.push(at + 'headings deeper than ### are not supported');
    if (/^(?:\*|\+)\s/.test(trimmed)) problems.push(at + 'use "-" for list bullets');
    if (/<[a-zA-Z/]/.test(trimmed)) problems.push(at + 'raw HTML is not supported');
    if (/^\s{2,}[-*+]\s/.test(line)) problems.push(at + 'nested lists are not supported');
  });
  return problems;
}
