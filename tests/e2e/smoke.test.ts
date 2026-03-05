import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('home page loads without errors', async ({ page }) => {
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

  test('unauthenticated user is redirected to /auth', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/auth/);
    await expect(page.getByText(/Sign in to Loop/i)).toBeVisible();
  });

  test('auth page has email input', async ({ page }) => {
    await page.goto('/auth');
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Send verification code/i })).toBeVisible();
  });
});
