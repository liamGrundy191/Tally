// T2.3 and T2.4 "Done when": a person reviews the three flagged fixture tickets with the keyboard
// only, and answers a workplace question on the Workplaces page. The tickets are seeded by
// apps/api/test/e2e-seed.test.ts (pnpm e2e): a disputed reading, a crossed-out ticket and one the
// reader could not read. Names are invented.
import { type Page, expect, test } from '@playwright/test';

const USER = { email: 'e2e@example.com', password: 'e2e password 1' };

/** Yesterday in Israel, the fixtures' date (as the seed sets it). */
const day = new Date(
  `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())}T00:00:00Z`,
);
day.setUTCDate(day.getUTCDate() - 1);
const YESTERDAY = day.toLocaleDateString('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  timeZone: 'UTC',
});
const MONTH = day.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Presses Tab until the focused element is the one named, as a keyboard user would. */
async function tabTo(page: Page, name: string) {
  for (let i = 0; i < 40; i++) {
    const here = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
    });
    if (here === name) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached "${name}"`);
}

test('reviews the three fixture tickets and answers a workplace question, keyboard only', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(USER.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(USER.password);
  await page.keyboard.press('Enter');
  // Home: the months; a month's own tickets are checked from inside the month (D63).
  await expect(page.getByRole('link', { name: `Open ${MONTH}` })).toBeVisible();
  await tabTo(page, `Open ${MONTH}`);
  await page.keyboard.press('Enter');
  await tabTo(page, 'Check next');
  await page.keyboard.press('Enter');

  // 1. Disputed: the end time unclear (the guess is filled in), the total read two ways.
  const end = page.locator('#f-endTime');
  await expect(end).toBeFocused();
  await expect(end).toHaveValue('06:00');
  await expect(page.locator('#f-totalWorked')).toHaveValue('');
  await expect(page.locator('[data-box="endTime"]')).toBeVisible();
  const started = Date.now();
  await page.keyboard.press('Enter');
  await expect(page.locator('#f-totalWorked')).toBeFocused();
  await page.keyboard.type('08:00');
  await page.keyboard.press('Enter');
  await expect(page.locator('#f-workerName')).toBeFocused();
  await page.keyboard.type('Ziv');
  await page.keyboard.press('Enter');

  // 2. Crossed out: removed, after a question whose focus starts on Cancel.
  await expect(page.getByText('This ticket looks crossed out. Remove it?')).toBeVisible();
  await expect(page.locator('input[type="checkbox"]')).toBeFocused();
  await tabTo(page, 'More');
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Remove ticket' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');

  // 3. Not read at all, so in no month yet: from Home's "Add the date". Typed in, the same worker
  // and day as the first, the place spelt apart.
  await expect(page.getByText('Nothing left to check.')).toBeVisible();
  await tabTo(page, 'Home');
  await page.keyboard.press('Enter');
  await tabTo(page, 'Add the date');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Could not read this ticket. Please type it in.')).toBeVisible();
  await expect(page.locator('#f-firstName')).toBeFocused();
  for (const value of ['זיו', 'שופר סל', YESTERDAY, '08:00', '16:00', '08:00']) {
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('#f-workerName')).toBeFocused();
  await page.keyboard.type('Ziv');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Nothing left to check.')).toBeVisible();
  console.log(`Three tickets reviewed in ${Date.now() - started} ms after the first loaded.`);

  // A place like the first ticket's: both wait for a person to say whether it is the same place.
  await tabTo(page, 'Back to Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: `Open ${MONTH}` })).toBeVisible();
  await tabTo(page, `Open ${MONTH}`);
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 workplace question to answer')).toBeVisible();

  // 4. The Workplaces page: "same place", after "Are you sure?" with Cancel focused.
  await tabTo(page, 'Answer workplace questions');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Is .+ the same place as .+\?$/)).toBeVisible();
  await tabTo(page, 'Same place, keep the name שופרסל');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Are you sure?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  // The focus moves on, so the keyboard carries on from there.
  await expect(page.getByText('No workplace questions to answer.')).toBeFocused();

  // 5. One place now: the two tickets of one worker and day ask whether they are one shift.
  await tabTo(page, MONTH);
  await page.keyboard.press('Enter');
  await tabTo(page, 'Check next');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Is it the same shift?')).toBeVisible();
  await tabTo(page, 'Keep both');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Nothing left to check.')).toBeVisible();

  // The month: two tickets ready in one workplace, one removed; the list has the other spelling.
  await tabTo(page, 'Back to the month');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/2 tickets ready for the Excel; 1 removed/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'שופרסל', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'שופר סל', exact: true })).toHaveCount(0);
  await tabTo(page, 'Spelling lists');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Workplace list')).toHaveValue('שופרסל = שופר סל');
});
