import { useEffect } from 'react';
import { HELP_PAGES, helpPath } from '../../lib/help/pages';

// /help, and any /help/<slug> that names no page — a stale link from an old
// email lands somewhere useful instead of a blank screen.

export default function HelpIndex() {
  useEffect(() => { document.title = 'Help'; }, []);

  return (
    <div className="help-screen">
      <div className="help">
        <nav className="help__nav">
          <a className="help__nav-link" href="/">← Apex Training</a>
        </nav>
        <article className="help__body">
          <h1 className="help__h1">Help</h1>
          <ul className="help-index">
            {HELP_PAGES.map(p => (
              <li key={p.slug} className="help-index__item">
                <a className="help-index__link" href={helpPath(p.slug)}>{p.title}</a>
                <p className="help-index__summary">{p.summary}</p>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </div>
  );
}
