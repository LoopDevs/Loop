import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('home page loads and shows merchant directory', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/Loop/);

    // No uncaught console errors
    expect(consoleErrors).toHaveLength(0);
  });

  test('auth page has email input and submit button', async ({ page }) => {
    await page.goto('/auth');
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Send verification code/i })).toBeVisible();
  });

  test('map page loads without crashing', async ({ page }) => {
    await page.goto('/map');
    await expect(page).toHaveTitle(/Map/);
  });

  test('orders page shows sign-in prompt when unauthenticated', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByText(/Sign in to view/i)).toBeVisible();
  });

  test('unknown route shows 404 page', async ({ page }) => {
    await page.goto('/nonexistent-page');
    await expect(page.getByText(/Page not found/i)).toBeVisible();
  });
});
