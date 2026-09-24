# Help pages

One markdown file per page Apex hosts at `/help/<slug>`. The slug list lives in
`src/lib/help/pages.ts`; a page that is not listed there does not render, and a
listed slug without a file fails `src/lib/help/__tests__/documents.test.ts`.

Audience: a tech-illiterate adult on a phone. Short sentences, one idea per
paragraph, every button named exactly as the screen shows it, in bold. Screenshots
carry the explanation — the words say what to look for in the picture.

## Format

```markdown
# <Title — must match pages.ts>

<One paragraph: what this page gets you.>

## 1. <Step>

![<what the reader should see>](/help/<slug>/01-<name>.phone.png)

<One or two sentences.>
```

- Same markdown dialect as `legal/*.md` (headings, paragraphs, lists, bold, code,
  links) **plus images**, which the legal renderer still rejects.
- Image paths are absolute and must match
  `/help/<slug>/<nn>-<name>.(phone|desktop).png`; the file lives at
  `public/help/<slug>/`. Phone shots are the default; add a `.desktop` variant only
  where the desktop layout is genuinely different.
- Screenshots are generated, never hand-taken: `e2e/shots/<slug>.shots.ts` drives
  the mock app and writes the PNGs
  (`APEX_PORT=<port> npx playwright test --project=shots-phone --project=shots-desktop e2e/shots/<slug>.shots.ts`).
  Re-run it after any UI change the page shows.

## External sites

Sites the mock app cannot render (console.anthropic.com, coros.com, Apple/Google
Calendar) are captured by the orchestrator through Chrome, reviewed by Shane, and
committed separately. Until then the page carries a placeholder:

```markdown
<!-- EXTERNAL: https://console.anthropic.com/settings/keys — API keys page, empty list, "Create Key" visible; 1280 wide; redact org name -->
![The API keys page with the Create Key button](/help/get-api-key/03-api-keys-empty.desktop.png)
```

The documents test tolerates a missing PNG only while the `EXTERNAL:` comment sits
directly above it. Remove the comment when the file lands.
