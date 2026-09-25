import { test, expect } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

// Screenshots for help/calendar-feed.md. Only step 1 is Apex; steps 2–4 are
// Apple and Google Calendar, which the mock app cannot render — those sit
// under EXTERNAL placeholders in the page until they are captured by hand.
//
// Phone only: the Profile overlay is the same single column on a desktop,
// and the reader who needs this page is holding the phone they subscribe on.

test('Profile → Calendar feed, with the address and its copy button', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'shots-phone', 'phone-only shot');

  await page.goto('/');
  await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();

  const fold = page.locator('.profile-fold').filter({ hasText: 'Calendar feed' });
  await fold.getByRole('button', { name: /Calendar feed/ }).click();
  const address = fold.locator('.profile-feed__url');
  await expect(address).toHaveValue(/\/api\/calendar-feed\?token=driver-ics-token$/);

  // Centred, so the fold's title, the hint, the address and the button all
  // sit in frame below the overlay's sticky header, with Connections above.
  await fold.evaluate(el => el.scrollIntoView({ block: 'center' }));
  // A click leaves focus on the toggle — its ring would be in the picture.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // The field shows publicOrigin(), which under the mock is this worktree's
  // localhost port: a reader would see a host they will never have, and the
  // PNG would change with every lane that regenerates it. Paint the
  // production host into the field for the picture only (React does not
  // re-render it before the shot); the token stays the fixture's.
  await address.evaluate(el => {
    const input = el as HTMLInputElement;
    input.value = input.value.replace(/^https?:\/\/[^/]+/, 'https://apextrainingcalendar.vercel.app');
  });

  const copy = fold.getByRole('button', { name: 'Copy address' });
  await expect(copy).toBeVisible();
  await helpShot(page, { slug: 'calendar-feed', n: 1, name: 'feed-address', highlight: copy });
});
