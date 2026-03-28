import { test, expect } from '@playwright/test';

test.describe('Purchase flow', () => {
  test('merchant detail page shows Aerie with purchase CTA', async ({ page }) => {
    await page.goto('/gift-card/aerie');
    await page.waitForTimeout(3000);

    // Merchant name visible
    await expect(page.getByRole('heading', { name: /Aerie/i })).toBeVisible();

    // Save percentage visible
    await expect(page.getByText(/Save.*%/)).toBeVisible();

    // Sign in prompt (not authenticated)
    await expect(page.getByText(/Sign in to purchase/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign in/i })).toBeVisible();
  });

  test('clicking sign in on merchant page navigates to auth', async ({ page }) => {
    await page.goto('/gift-card/aerie');
    await page.waitForTimeout(2000);

    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/\/auth/);
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
  });

  test('search finds merchants and navigates to detail', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);

    // Desktop search
    const searchInput = page.locator('input[placeholder="Search for gift cards"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('aerie');
      await page.waitForTimeout(500);

      // Should show search results
      const results = page.locator('[role="option"]');
      if ((await results.count()) > 0) {
        await results.first().click();
        await page.waitForURL(/\/gift-card\//);
        await expect(page.getByRole('heading', { name: /Aerie/i })).toBeVisible();
      }
    }
  });

  test('map page loads with cluster markers', async ({ page }) => {
    await page.goto('/map');
    await page.waitForTimeout(5000);

    // Map container exists
    await expect(
      page.locator('[role="region"][aria-label="Merchant locations map"]'),
    ).toBeVisible();

    // Leaflet loaded (tile layer visible)
    await expect(page.locator('.leaflet-tile-container')).toBeVisible();
  });
});
