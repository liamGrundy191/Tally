// T2.5 "Done when": the seeded admin invites a reviewer, the reviewer sets a password through the
// link and lands on Home with no Logins page. The link is read from the page, not the clipboard
// (headless browsers have none). Emails are invented.
import { expect, test } from '@playwright/test';

const ADMIN = { email: 'e2e@example.com', password: 'e2e password 1' };

test('an admin invites a reviewer, who sets a password and logs in', async ({ page }) => {
  // A new email each run: `pnpm --filter @tally/web e2e` alone does not reseed the database.
  const email = `reviewer-${Date.now()}@example.com`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('button', { name: ADMIN.email }).click();
  await page.getByRole('menuitem', { name: 'Logins' }).click();
  await expect(page.getByRole('heading', { name: 'Logins' })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(ADMIN.email) })).toContainText(
    'This is you.',
  );

  await page.getByLabel('Email').fill(email);
  await expect(page.getByLabel('Reviewer')).toBeChecked();
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(`Send this link to ${email}.`)).toBeVisible();
  const link = await page.getByLabel('Invite link').inputValue();
  expect(link).toMatch(/^http:\/\/localhost:4173\/accept-invite#token=/);

  await page.getByRole('button', { name: ADMIN.email }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.goto(link);
  await page.getByLabel('New password').fill('reviewer password 1');
  await page.getByLabel('Type it again').fill('reviewer password 1');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Logins' })).toHaveCount(0);
});
