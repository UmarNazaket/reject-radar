import { expect, type Page, test } from '@playwright/test';

// Runs against the API with apps/web-e2e/seed.sql loaded (see .github/workflows/e2e.yml). One account is shared, and
// one test changes its language, so the tests run one after another.
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email = 'e2e@example.com'): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'e2e-check-2026');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/topics/);
}

test('a wrong password is refused in words', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name=email]', 'e2e@example.com');
  await page.fill('input[name=password]', 'not-the-password');
  await page.click('button[type=submit]');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('the topic check shows a dashboard for an origin', async ({ page }) => {
  await signIn(page);
  await page.locator('mat-select').first().click();
  await page.getByRole('option', { name: 'India' }).click();
  await expect(page).toHaveURL(/origin=IN/);
  await expect(page.locator('app-topic-dashboard dl')).toContainText('United States');
  await expect(page.locator('app-notice-table tbody tr').first()).toBeVisible();
});

test('a notice leads to its Import Alert and its summary', async ({ page }) => {
  await signIn(page);
  await page.goto('/notices?source=import_alert');
  await page.locator('app-notice-table tbody tr a').first().click();
  await expect(page).toHaveURL(/\/notices\/\d+/);
  await page.getByRole('link', { name: 'Open Import Alert 99-08' }).click();
  await expect(page.locator('h1')).toContainText('Processed Foods for Pesticides');
  await expect(page.locator('main')).toContainText('FDA holds processed foods');
});

test('a firm profile asks before using a lookup, and the firm can be watched', async ({ page }) => {
  await signIn(page);
  await page.goto('/firms?name=e2e%20spice%20mills');
  await page.getByRole('link', { name: 'E2E Spice Mills Pvt Ltd' }).click();
  await page.getByRole('button', { name: 'Open profile' }).click();
  await expect(page.locator('h1')).toHaveText('E2E Spice Mills Pvt Ltd');
  await expect(page.locator('main')).toContainText('History: 1 older record');
  await page.getByRole('button', { name: 'Watch this firm' }).click();
  await expect(page.locator('main app-alert').last()).toContainText('Added to your watchlist');
  await page.goto('/watchlist');
  await expect(page.locator('main')).toContainText('E2E Spice Mills Pvt Ltd');
});

test('Urdu turns the page right to left', async ({ page }) => {
  await signIn(page);
  await page.selectOption('app-language-select select', 'ur');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('h1')).toHaveText('موضوع کی جانچ');
  // Back to English, so the account's language is as the other tests expect.
  await page.selectOption('app-language-select select', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('staff keep two firms apart in the match review, which customers cannot open', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/matches');
  await expect(page.locator('h1')).toContainText('Page not found');

  await page.context().clearCookies();
  await signIn(page, 'e2e-staff@example.com');
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Match review' }).click();
  const review = page.locator('main li').filter({ hasText: 'FDA refusal e2e-r1' });
  await expect(review).toContainText('E2E Spice Mill (#');
  page.once('dialog', (dialog) => void dialog.accept());
  await review.getByRole('button', { name: 'Different firms' }).click();
  await expect(page.locator('main')).toContainText('No reviews here.');
  await page.getByRole('link', { name: 'Different firms' }).click();
  await expect(page.locator('main li').filter({ hasText: 'FDA refusal e2e-r1' })).toBeVisible();
});
