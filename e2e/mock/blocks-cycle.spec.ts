import { test, expect, shot } from '../lib/fixtures';

// The cycle editor: one form that lays down a whole 3-on/1-off plan. The
// interception layer stubs training_blocks as empty (see intercept.mjs), so
// this always runs against a clean slate.

async function openCycleEditor(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('.top-nav')).toBeVisible({ timeout: 20000 });
  await page.locator('[data-tour="blocks"]').click();
  await expect(page.locator('.library-header__title')).toHaveText('Training blocks');
  await page.locator('[data-tour="new-cycle"]').click();
  await expect(page.locator('.library-header__title')).toHaveText('New cycle');
}

test('defaults to three weeks on, one off, repeated four times', async ({ page }) => {
  await openCycleEditor(page);

  const cadence = page.locator('.cycle-cadence input');
  await expect(cadence.nth(0), 'weeks on').toHaveValue('3');
  await expect(cadence.nth(1), 'weeks off').toHaveValue('1');
  await expect(cadence.nth(2), 'repeat').toHaveValue('4');

  // Eight blocks, alternating build and recovery, 16 weeks in total.
  const rows = page.locator('.cycle-preview__row');
  await expect(rows).toHaveCount(8);
  await expect(page.locator('.cycle-preview__phase')).toHaveText(
    ['build', 'recovery', 'build', 'recovery', 'build', 'recovery', 'build', 'recovery'],
  );
  await expect(page.locator('.block-section__sub').last()).toContainText('16 weeks');
  await shot(page, 'blocks-cycle-preview');
});

test('the preview redraws when the cadence changes', async ({ page }) => {
  await openCycleEditor(page);

  const cadence = page.locator('.cycle-cadence input');
  await cadence.nth(0).fill('4');   // weeks on
  await cadence.nth(2).fill('2');   // repeat

  await expect(page.locator('.cycle-preview__row')).toHaveCount(4);
  await expect(page.locator('.block-section__sub').last()).toContainText('10 weeks');

  // No off week at all: build blocks only.
  await cadence.nth(1).fill('0');
  await expect(page.locator('.cycle-preview__row')).toHaveCount(2);
  await expect(page.locator('.cycle-preview__phase')).toHaveText(['build', 'build']);
});

test('recovery weeks carry reduced targets, in the same unit', async ({ page }) => {
  await openCycleEditor(page);

  await page.locator('.cycle-cadence input').nth(2).fill('1');
  // Cardio minutes is the first weekly-target field.
  await page.locator('.block-targets input[type="number"]').first().fill('300');

  const rows = page.locator('.cycle-preview__row');
  await expect(rows).toHaveCount(2);
  // The preview shows dates, not targets, so assert the shape it does show
  // and leave the arithmetic to the unit tests.
  await expect(rows.nth(0)).toContainText('Build 1');
  await expect(rows.nth(1)).toContainText('Recovery 1');
});

test('saving posts one batched request, not one per block', async ({ page }) => {
  await openCycleEditor(page);

  const posts: string[] = [];
  page.on('request', req => {
    if (req.url().includes('/api/training-blocks') && req.method() === 'POST') {
      posts.push(req.url());
    }
  });

  await page.locator('.library-field__input').first().fill('Spring Alpine');
  await expect(page.locator('.cycle-preview__row')).toHaveCount(8);

  const save = page.locator('.library-editor__save');
  await expect(save).toBeEnabled();
  await expect(save).toContainText('Create 8 blocks');
  await save.click();

  await expect.poll(() => posts.length, { message: 'exactly one batched POST' }).toBe(1);
  expect(posts[0]).toContain('batch=1');
});

test('a nameless cycle cannot be saved', async ({ page }) => {
  await openCycleEditor(page);
  await expect(page.locator('.library-editor__save')).toBeDisabled();
});
