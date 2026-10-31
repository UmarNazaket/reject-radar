import { expect, test } from '@playwright/test';

test('a signed-out visitor sees the landing page, and a signed-in page sends them to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('See which food shipments are rejected at the border');
  await page.goto('/topics');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('h1')).toContainText('Sign in to RejectRadar');
});
