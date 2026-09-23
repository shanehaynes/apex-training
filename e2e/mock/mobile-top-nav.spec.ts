import { test, expect, shot } from '../lib/fixtures';

// 375 is the narrowest current iPhone. The desktop top nav is ~640px wide, and
// on a phone its right-hand buttons used to hang off-screen, unreachable.
test.use({ viewport: { width: 375, height: 812 } });

test('top nav fits a phone and the day view carries the way back to today', async ({ page }) => {
  await page.goto('/');
  await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });

  const overflow = await page.locator('.top-nav').evaluate(el => {
    const vw = document.documentElement.clientWidth;
    return [...el.querySelectorAll('button')]
      .filter(b => b.getBoundingClientRect().width > 0)
      .filter(b => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > vw; })
      .map(b => b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent);
  });
  expect(overflow, 'no top-nav button extends past the viewport').toEqual([]);
  await expect(page.getByTestId('nav-blocks')).toBeVisible();
  await expect(page.locator('.top-nav button[title="Exercise library"]')).toBeVisible();
  await shot(page, 'mobile-top-nav');

  const period = page.locator('.nav-period');
  const today = await period.textContent();
  await expect(page.getByTestId('day-view-go-today'), 'no Today button while on today').toHaveCount(0);

  await page.locator('.nav-arrow[aria-label="Next"]').click();
  await expect(period).not.toHaveText(today!);
  await page.getByTestId('day-view-go-today').click();
  await expect(period).toHaveText(today!);
});
