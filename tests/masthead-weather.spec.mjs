import { expect, test } from '@playwright/test';

const weather = [
  [24.8, 0, 1], [22.1, 1, 1], [20.4, 3, 1],
  [21.6, 61, 1], [19.2, 71, 1], [18.7, 0, 0],
  [23.3, 2, 1], [17.4, 63, 1], [21.7, 0, 1],
  [22.6, 0, 1], [21.4, 3, 1], [20.1, 2, 1], [19.7, 63, 1],
  [18.9, 61, 1], [21.8, 1, 1], [9.4, 3, 1], [20.6, 0, 1],
  [18.8, 61, 1], [22.9, 0, 1], [21.1, 2, 1],
  [20.3, 3, 1], [19.5, 61, 1], [18.9, 2, 1], [21.2, 0, 1],
  [20.8, 61, 1], [19.7, 3, 1], [21.4, 0, 1], [18.3, 63, 1], [24.6, 1, 1],
  [22.4, 1, 1],
  [19.6, 3, 1], [18.8, 61, 1], [16.1, 2, 1], [15.3, 63, 1], [10.4, 3, 1],
  [18.7, 0, 1], [17.9, 61, 1], [16.4, 3, 1], [15.8, 2, 1], [20.2, 0, 1],
  [18.6, 61, 1], [21.3, 1, 1], [20.1, 2, 1], [19.8, 3, 1], [17.5, 61, 1],
  [18.4, 3, 1], [13.7, 2, 1],
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
  await expect(ribbon.locator('.masthead-weather__city')).toHaveCount(47);
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(4);
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="campus"]')).toHaveCount(3);
  // Une seule ville des Premières Nations ou inuit parmi les trois cartes secondaires.
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="nation"]')).toHaveCount(1);
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('data-weather-city', 'montreal');
  const activeBoxes = (await ribbon.locator('.masthead-weather__city.is-active').evaluateAll((cities) => cities
    .map((city) => city.getBoundingClientRect())
    .sort((a, b) => a.x - b.x)
    .map(({ width }) => width)));
  expect(activeBoxes[0]).toBeLessThan(activeBoxes[1]);
  await expect(ribbon.locator('.masthead-weather__city.is-active').first()).toHaveAttribute('href', /^https:\/\/meteo\.gc\.ca\/fr\/location\/index\.html\?coords=/);
  await expect(ribbon.locator('[data-weather-city="vaudreuil-soulanges"]')).toHaveAttribute(
    'href',
    /coords=45\.398%2C-74\.032$/,
  );
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
  await page.waitForTimeout(100);
  const countAt1200 = await ribbon.locator('.masthead-weather__city.is-active').count();
  await expect(ribbon.locator('.masthead-weather__board')).toHaveAttribute('data-weather-count', String(countAt1200));

  await page.setViewportSize({ width: 1050, height: 900 });
  await page.waitForTimeout(100);
  const countAt1050 = await ribbon.locator('.masthead-weather__city.is-active').count();
  expect(countAt1050).toBeLessThanOrEqual(countAt1200);
  await expect(ribbon.locator('.masthead-weather__board')).toHaveAttribute('data-weather-count', String(countAt1050));

  await page.setViewportSize({ width: 920, height: 900 });
  await page.waitForTimeout(100);
  const countAt920 = await ribbon.locator('.masthead-weather__city.is-active').count();
  expect(countAt920).toBeLessThanOrEqual(countAt1050);
  expect(countAt920).toBeGreaterThanOrEqual(1);
  await expect(ribbon.locator('.masthead-weather__board')).toHaveAttribute('data-weather-count', String(countAt920));

  await page.setViewportSize({ width: 610, height: 900 });
  await expect(ribbon).toBeHidden();
});
