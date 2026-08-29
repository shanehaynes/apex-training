import { useMemo } from 'react';
import type { Block, Inline } from '../../lib/legal/markdown';
import { parseLegalMarkdown } from '../../lib/legal/markdown';
import { LEGAL_DOCUMENTS, type LegalSlug } from '../../lib/legal/versions';
import termsSource from '../../../legal/terms-v1.md?raw';
import privacySource from '../../../legal/privacy-v1.md?raw';

// The /terms and /privacy pages. Rendered by App.tsx BEFORE AuthProvider,
// because the signup checkbox links here and a signed-out visitor must be
// able to read what they are being asked to agree to.
//
// The markdown is bundled at build time (?raw) rather than fetched, so the
// document a user reads is pinned to the deployed version — the same commit
// that defines TERMS_VERSION. Fetching would let the two drift.
//
// parseLegalMarkdown strips HTML comments before parsing, which is what keeps
// the documents' `<!-- LEGAL REVIEW: ... -->` annotations off the page. React
// escapes every text node below; there is no dangerouslySetInnerHTML here.

const SOURCES: Record<LegalSlug, string> = {
  terms: termsSource,
  privacy: privacySource,
};

function renderInlines(inlines: Inline[]) {
  return inlines.map((inline, i) => {
    switch (inline.type) {
      case 'strong': return <strong key={i}>{inline.text}</strong>;
      case 'code':   return <code key={i} className="legal__code">{inline.text}</code>;
      case 'link':   return <a key={i} href={inline.href}>{inline.text}</a>;
      default:       return <span key={i}>{inline.text}</span>;
    }
  });
}

function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case 'heading': {
      const H = `h${block.level}` as 'h1' | 'h2' | 'h3';
      return <H key={key} className={`legal__h${block.level}`}>{renderInlines(block.inlines)}</H>;
    }
    case 'paragraph':
      return <p key={key} className="legal__p">{renderInlines(block.inlines)}</p>;
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{renderInlines(item)}</li>);
      return block.ordered
        ? <ol key={key} className="legal__list">{items}</ol>
        : <ul key={key} className="legal__list">{items}</ul>;
    }
    case 'table':
      // Wrapped so a wide table scrolls itself instead of the page.
      return (
        <div key={key} className="legal__table-wrap">
          <table className="legal__table">
            <thead>
              <tr>{block.head.map((cell, i) => <th key={i}>{renderInlines(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}>{renderInlines(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr key={key} className="legal__rule" />;
  }
}

export default function LegalPage({ slug }: { slug: LegalSlug }) {
  const doc = useMemo(() => parseLegalMarkdown(SOURCES[slug]), [slug]);
  const other = LEGAL_DOCUMENTS.find(d => d.slug !== slug)!;

  return (
    <div className="legal-screen">
      <div className="legal">
        <nav className="legal__nav">
          <a className="legal__nav-link" href="/">← Apex Training</a>
          <a className="legal__nav-link" href={other.path}>{other.title}</a>
        </nav>
        <article className="legal__body">
          {doc.blocks.map(renderBlock)}
        </article>
      </div>
    </div>
  );
}
