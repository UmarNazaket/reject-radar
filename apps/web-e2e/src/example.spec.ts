import { expect, test } from '@playwright/test';

test('a signed-out visitor lands on the sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('h1')).toContainText('Sign in to RejectRadar');
});
