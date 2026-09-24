// Screenshots for help/get-api-key.md, steps 6 and 7: Profile's Anthropic key
// section with no key yet, then with one saved. Steps 1–5 are
// console.anthropic.com and are captured separately (help/README.md,
// "External sites").
//
//   APEX_PORT=<port> npx playwright test --project=shots-phone \
//     --project=shots-desktop e2e/shots/get-api-key.shots.ts

import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

/** Not a real key: the shape a reader will paste, and nothing more. */
const FAKE_KEY = 'sk-ant-api03-not-a-real-key-abcd';

/**
 * No key saved until the page PATCHes one; after that, report it saved with
 * the fixture's last four. The section opens by itself while no key is set.
 */
async function stubKeyStatus(page: Page) {
  let saved = false;
  await page.route('**/api/profile', route => {
    const req = route.request();
    const body = req.postDataJSON() as Record<string, unknown> | null;
    if (req.method() === 'PATCH' && body && 'anthropic_api_key' in body) saved = body.anthropic_api_key !== null;
    else if (req.method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify({
        ...(req.method() === 'PATCH' ? { ok: true } : {}),
        hasAnthropicKey: saved,
        anthropicKeyLast4: saved ? 'abcd' : null,
        termsAccepted: null,
        termsCurrent: true,
      }),
    });
  });
}

/**
 * Bring the section's title to the top of Profile's scroller, clear of the
 * sticky header — scrollIntoView alone parks it underneath.
 */
async function frameSection(section: import('@playwright/test').Locator) {
  await section.evaluate(el => {
    el.scrollIntoView({ block: 'start' });
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const header = document.querySelector('.profile-view .library-header');
    if (scroller && header) {
      const gap = header.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      if (gap > 0) scroller.scrollTop -= gap + 8;
    }
  });
}

async function openProfile(page: Page, phone: boolean) {
  if (phone) {
    await page.goto('/');
    await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });
  } else {
    await gotoCalendar(page);
  }
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
}

test('Profile: paste the key, then it is saved', async ({ page }, testInfo) => {
  const phone = testInfo.project.name === 'shots-phone';
  await stubKeyStatus(page);
  await openProfile(page, phone);

  const input = page.getByLabel('Anthropic API key', { exact: true });
  await expect(input).toBeVisible();
  await input.fill(FAKE_KEY);
  // Blur, so no caret or focus ring competes with the highlight.
  await input.evaluate(el => (el as HTMLInputElement).blur());

  const save = page.getByRole('button', { name: 'Save key' });
  await expect(save).toBeEnabled();
  // Frame the whole section from its title down — the hint above the box
  // is what the page tells the reader to look for.
  const section = page.locator('.profile-fold', {
    has: page.locator('.profile-section__title', { hasText: /^Anthropic API key$/ }),
  });
  await frameSection(section);
  await helpShot(page, { slug: 'get-api-key', n: 6, name: 'paste-key', highlight: save });

  await save.click();
  const masked = page.getByLabel('Saved API key (masked)');
  await expect(masked).toHaveValue('sk-ant-…abcd');
  await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
  // The "API key saved" toast is part of what the reader sees; let it land.
  await frameSection(section);
  await helpShot(page, { slug: 'get-api-key', n: 7, name: 'key-saved', highlight: masked });
});
