import { expect, test } from '@playwright/test';

const weather = [
  [24.8, 0, 1], [22.1, 1, 1], [20.4, 3, 1],
  [21.6, 61, 1], [19.2, 71, 1], [18.7, 0, 0],
].map(([temperature_2m, weather_code, is_day]) => ({
  current: { temperature_2m, weather_code, is_day },
}));

test('météo campus : elle s’adapte à la largeur du masthead', async ({ page }) => {
  await page.route('https://api.open-meteo.com/v1/forecast**', (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(weather),
  }));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const ribbon = page.locator('#masthead-weather');
  await expect(ribbon).toBeVisible();
  await expect(ribbon.locator('.masthead-weather__temp').first()).toHaveText('25°');
  await expect(ribbon.locator('.masthead-weather__city:visible')).toHaveCount(6);

  await page.setViewportSize({ width: 1050, height: 900 });
  await expect(ribbon.locator('.masthead-weather__city:visible')).toHaveCount(4);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(ribbon.locator('.masthead-weather__city:visible')).toHaveCount(2);

  await page.setViewportSize({ width: 840, height: 900 });
  await expect(ribbon).toBeHidden();
});
