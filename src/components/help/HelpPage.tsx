import { useEffect, useMemo } from 'react';
import { parseLegalMarkdown } from '../../lib/legal/markdown';
import { HELP_PAGES, type HelpSlug } from '../../lib/help/pages';
import { HELP_SOURCES } from '../../lib/help/sources';
import MarkdownBlocks from '../legal/MarkdownBlocks';

// /help/<slug>. Rendered by App.tsx ABOVE AuthProvider, like the legal pages:
// tips, the intro and emails link here, and a signed-out reader (or the iOS
// app opening a browser) must get the page, not a sign-in screen.
//
// The page's first `# ` heading is its title (the documents test pins it to
// pages.ts), so the chrome does not repeat it.

export default function HelpPage({ slug }: { slug: HelpSlug }) {
  const page = HELP_PAGES.find(p => p.slug === slug)!;
  const blocks = useMemo(() => parseLegalMarkdown(HELP_SOURCES[slug]).blocks, [slug]);

  useEffect(() => { document.title = page.title; }, [page.title]);

  return (
    <div className="help-screen">
      <div className="help">
        <nav className="help__nav">
          <a className="help__nav-link" href="/">← Apex Training</a>
          <a className="help__nav-link" href="/help">All help</a>
        </nav>
        <article className="help__body">
          <MarkdownBlocks blocks={blocks} prefix="help" />
        </article>
      </div>
    </div>
  );
}
