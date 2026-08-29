import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Strips `<!-- LEGAL REVIEW: ... -->` annotations out of the legal documents
// at BUILD time, before they enter the bundle.
//
// Why this exists as a plugin and not just the runtime strip in
// src/lib/legal/markdown.ts: `?raw` inlines the file's bytes verbatim into
// the JS chunk. The renderer's strip keeps comments off the rendered page,
// but the raw source — questions addressed to a lawyer about our own legal
// exposure — was still sitting in a production asset, readable by anyone who
// opened devtools or curled the chunk. Shipping them is publishing them.
//
// So the comments are removed here, and markdown.ts strips again at render
// time. Two layers, because the failure mode is silent and the cost is one
// regex.
//
// Intercepting with enforce: 'pre' + load() takes priority over Vite's own
// ?raw handling, so the built-in asset plugin never sees the original bytes.

const LEGAL_RAW_RE = /[/\\]legal[/\\][\w.-]+\.md\?raw$/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export default function legalDocsPlugin(): Plugin {
  return {
    name: 'apex-legal-docs',
    enforce: 'pre',
    load(id) {
      if (!LEGAL_RAW_RE.test(id)) return null;
      const source = readFileSync(id.slice(0, id.indexOf('?')), 'utf8');
      return `export default ${JSON.stringify(source.replace(HTML_COMMENT_RE, ''))};`;
    },
  };
}
