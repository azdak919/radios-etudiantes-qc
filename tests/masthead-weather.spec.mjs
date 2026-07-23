import { expect, test } from '@playwright/test';

const weather = [
  [24.8, 0, 1], [22.1, 1, 1], [20.4, 3, 1],
  [21.6, 61, 1], [19.2, 71, 1], [18.7, 0, 0],
  [23.3, 2, 1], [17.4, 63, 1], [21.7, 0, 1],
  [22.6, 0, 1], [21.4, 3, 1], [20.1, 2, 1], [19.7, 63, 1],
  [18.9, 61, 1], [21.8, 1, 1], [9.4, 3, 1], [20.6, 0, 1],
  [18.8, 61, 1], [22.9, 0, 1], [21.1, 2, 1],
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
  await expect(ribbon.locator('.masthead-weather__city.is-active .masthead-weather__temp').first()).not.toHaveText('—');
  await expect(ribbon.locator('.masthead-weather__city')).toHaveCount(20);
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(4);
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="campus"]')).toHaveCount(2);
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="nation"]')).toHaveCount(2);
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('data-weather-city', 'montreal');
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('href', /^https:\/\/meteo\.gc\.ca\/fr\/location\/index\.html\?coords=/);
  await page.evaluate(() => {
    window.RadarTranslate = { ...(window.RadarTranslate || {}), getMode: () => 'en' };
    window.dispatchEvent(new CustomEvent('radar:translate-mode', { detail: { mode: 'en' } }));
  });
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('href', /^https:\/\/weather\.gc\.ca\/en\/location\/index\.html\?coords=/);
  const [weatherBox, actionsBox] = await Promise.all([
    ribbon.boundingBox(), page.locator('.masthead-actions').boundingBox(),
  ]);
  expect(actionsBox.x).toBeGreaterThan(weatherBox.x + weatherBox.width);

  const beforeRotation = await ribbon.locator('.masthead-weather__city.is-active').evaluateAll((cities) => cities.map((city) => city.dataset.weatherCity));
  const widthBeforeRotation = (await ribbon.boundingBox()).width;
  await page.waitForTimeout(5300);
  const afterRotation = await ribbon.locator('.masthead-weather__city.is-active').evaluateAll((cities) => cities.map((city) => city.dataset.weatherCity));
  const widthAfterRotation = (await ribbon.boundingBox()).width;
  expect(afterRotation.filter((id) => beforeRotation.includes(id))).toHaveLength(3);
  expect(widthAfterRotation).toBe(widthBeforeRotation);
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('data-weather-city', 'quebec');

  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(3);

  await page.setViewportSize({ width: 1050, height: 900 });
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(2);

  await page.setViewportSize({ width: 920, height: 900 });
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(1);

  await page.setViewportSize({ width: 880, height: 900 });
  await expect(ribbon).toBeHidden();
});
