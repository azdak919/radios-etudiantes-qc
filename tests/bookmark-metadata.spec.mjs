import { expect, test } from '@playwright/test';

for (const { path, title, icon } of [
  { path: '/', title: 'LE-RADAR.ca', icon: 'assets/icon.svg?v=2' },
  { path: '/pomo/', title: 'Pomo', icon: 'favicon.svg?v=2' },
  { path: '/solitaire/', title: 'Solitaire', icon: 'favicon.svg?v=2' },
]) {
  test(`favori ${path} : titre et favicon dédiés`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
    await expect(page).toHaveTitle(title);
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', icon);
  });
}
