import { test, expect } from '@playwright/test';

test.describe('Purchase flow', () => {
  test('merchant detail page loads with purchase card', async ({ page }) => {
    await page.goto('/');

    // Auto-retrying assertion: waits up to the default timeout (30s) for a
    // merchant link to appear. Previously this used waitForTimeout(4000) and
    // then `if (await link.isVisible())`, which made the whole test a silent
    // no-op when merchants failed to load — the worst case of "green CI that
    // actually caught nothing".
    const merchantLink = page.locator('a[href^="/gift-card/"]').first();
    await expect(merchantLink).toBeVisible();
    await merchantLink.click();
    await page.waitForURL(/\/gift-card\//);

    // Purchase card has an inline email input (inline auth flow).
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
  });

  test('search finds merchants and navigates to detail', async ({ page }) => {
    await page.goto('/');

    // Wait for the search input to mount (it lives in the nav which renders
    // as soon as the page loads — no need to wait for merchant data).
    const searchInput = page.locator('input[placeholder="Search for gift cards"]').first();
    await expect(searchInput).toBeVisible();

    // Type a letter common to many merchant names.
    await searchInput.fill('a');

    // Wait for dropdown results. The Navbar debounces input at 150ms.
    const results = page.locator('[role="option"]');
    await expect(results.first()).toBeVisible();

    await results.first().click();
    await page.waitForURL(/\/gift-card\//);
  });

  test('map page loads with leaflet', async ({ page }) => {
    await page.goto('/map');

    // Map container exists (lazy-loaded, so Leaflet's container takes a
    // moment to attach). toBeVisible auto-retries so no fixed wait needed.
    await expect(
      page.locator('[role="region"][aria-label="Merchant locations map"]'),
    ).toBeVisible();

    // Leaflet mounted — `.leaflet-container` is stable once Leaflet attaches.
    // Avoid asserting on `.leaflet-tile-container`: Leaflet toggles its
    // visibility during zoom animations and it depends on an external tile
    // fetch completing in CI, which made this test flaky.
    await expect(page.locator('.leaflet-container')).toBeVisible();
  });
});
