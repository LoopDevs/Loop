import { test, expect } from '@playwright/test';

test.describe('Purchase flow', () => {
  test('merchant detail page loads with purchase card', async ({ page }) => {
    // Go to home, wait for merchants to load, click the first one
    await page.goto('/');
    await page.waitForTimeout(4000);

    // Find any merchant card link and click it
    const merchantLink = page.locator('a[href^="/gift-card/"]').first();
    if (await merchantLink.isVisible()) {
      await merchantLink.click();
      await page.waitForURL(/\/gift-card\//);
      await page.waitForTimeout(2000);

      // Should show the purchase card with email input (inline auth)
      await expect(page.getByLabel(/Email address/i)).toBeVisible();
    }
  });

  test('search finds merchants and navigates to detail', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);

    // Desktop search
    const searchInput = page.locator('input[placeholder="Search for gift cards"]').first();
    if (await searchInput.isVisible()) {
      // Type a single letter to get results
      await searchInput.fill('a');
      await page.waitForTimeout(500);

      const results = page.locator('[role="option"]');
      if ((await results.count()) > 0) {
        await results.first().click();
        await page.waitForURL(/\/gift-card\//);
        // Should be on a merchant page
        await expect(page.url()).toContain('/gift-card/');
      }
    }
  });

  test('map page loads with tile layer', async ({ page }) => {
    await page.goto('/map');
    await page.waitForTimeout(5000);

    // Map container exists
    await expect(
      page.locator('[role="region"][aria-label="Merchant locations map"]'),
    ).toBeVisible();

    // Leaflet tile layer loaded
    await expect(page.locator('.leaflet-tile-container')).toBeVisible();
  });
});
