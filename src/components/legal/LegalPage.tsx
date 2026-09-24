import { useMemo } from 'react';
import { parseLegalMarkdown } from '../../lib/legal/markdown';
import MarkdownBlocks from './MarkdownBlocks';
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
          <MarkdownBlocks blocks={doc.blocks} />
        </article>
      </div>
    </div>
  );
}
