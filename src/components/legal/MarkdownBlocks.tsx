import type { Block, Inline } from '../../lib/legal/markdown';

// Maps the parser's blocks (src/lib/legal/markdown.ts) to elements. Shared by
// the legal pages and the help pages; React escapes every text node, so there
// is no dangerouslySetInnerHTML anywhere on either.
//
// `prefix` names the BEM block the classes hang off — `legal__p`, `help__p` —
// so each page family styles its own copy (app.css for legal, help.css for
// help) without either reaching into the other's rules.

function renderInlines(inlines: Inline[], prefix = 'legal') {
  return inlines.map((inline, i) => {
    switch (inline.type) {
      case 'strong': return <strong key={i}>{inline.text}</strong>;
      case 'code':   return <code key={i} className={`${prefix}__code`}>{inline.text}</code>;
      case 'link':   return <a key={i} href={inline.href}>{inline.text}</a>;
      default:       return <span key={i}>{inline.text}</span>;
    }
  });
}

function renderBlock(block: Block, key: number, prefix = 'legal') {
  const inlines = (items: Inline[]) => renderInlines(items, prefix);
  switch (block.type) {
    case 'heading': {
      const H = `h${block.level}` as 'h1' | 'h2' | 'h3';
      return <H key={key} className={`${prefix}__h${block.level}`}>{inlines(block.inlines)}</H>;
    }
    case 'paragraph':
      return <p key={key} className={`${prefix}__p`}>{inlines(block.inlines)}</p>;
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{inlines(item)}</li>);
      return block.ordered
        ? <ol key={key} className={`${prefix}__list`}>{items}</ol>
        : <ul key={key} className={`${prefix}__list`}>{items}</ul>;
    }
    case 'table':
      // Wrapped so a wide table scrolls itself instead of the page.
      return (
        <div key={key} className={`${prefix}__table-wrap`}>
          <table className={`${prefix}__table`}>
            <thead>
              <tr>{block.head.map((cell, i) => <th key={i}>{inlines(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}>{inlines(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'image':
      // Help pages only — legalMarkdownViolations() keeps images out of the
      // legal documents. The alt text doubles as the caption: the pages are
      // written for someone matching a picture to their own screen, so what to
      // look for is worth saying out loud, not only to a screen reader.
      return (
        <figure key={key} className="help__figure">
          <img src={block.src} alt={block.alt} loading="lazy" />
          <figcaption>{block.alt}</figcaption>
        </figure>
      );
    case 'rule':
      return <hr key={key} className={`${prefix}__rule`} />;
  }
}

export default function MarkdownBlocks({ blocks, prefix = 'legal' }: { blocks: Block[]; prefix?: string }) {
  return <>{blocks.map((block, i) => renderBlock(block, i, prefix))}</>;
}
