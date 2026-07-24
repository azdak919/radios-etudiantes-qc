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

function stubForecast(page) {
  return page.route('https://api.open-meteo.com/v1/forecast**', (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(weather),
  }));
}

test('météo campus : elle s’adapte à la largeur du masthead', async ({ page }) => {
  await stubForecast(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const ribbon = page.locator('#masthead-weather');
  await expect(ribbon).toBeVisible();
  await expect(ribbon.locator('.masthead-weather__city.is-active .masthead-weather__temp').first()).not.toHaveText('—');
  await expect(ribbon.locator('.masthead-weather__city')).toHaveCount(47);
  expect(await ribbon.locator('.masthead-weather__city').evaluateAll((cities) => cities.every(
    (city) => city.href.startsWith('https://www.meteomedia.com/fr/ville/ca/quebec/'),
  ))).toBe(true);
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(4);
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="campus"]')).toHaveCount(3);
  // Une seule ville des Premières Nations ou inuit parmi les trois cartes secondaires.
  await expect(ribbon.locator('.masthead-weather__city.is-active[data-weather-group="nation"]')).toHaveCount(1);
  const activePrimary = ribbon.locator('.masthead-weather__city.is-active[data-weather-city="montreal"], .masthead-weather__city.is-active[data-weather-city="quebec"]');
  await expect(activePrimary).toHaveCount(1);
  const activeBoxes = (await ribbon.locator('.masthead-weather__city.is-active').evaluateAll((cities) => cities
    .map((city) => city.getBoundingClientRect())
    .sort((a, b) => a.x - b.x)
    .map(({ width }) => width)));
  expect(activeBoxes[0]).toBeLessThan(activeBoxes[1]);
  const initialPrimary = await activePrimary.evaluate((el) => ({ id: el.dataset.weatherCity, href: el.href }));
  expect(initialPrimary.href).toBe(`https://www.meteomedia.com/fr/ville/ca/quebec/${initialPrimary.id}/actuelle`);
  await expect(ribbon.locator('[data-weather-city="vaudreuil-soulanges"]')).toHaveAttribute(
    'href',
    'https://www.meteomedia.com/fr/ville/ca/quebec/vaudreuil-dorion/actuelle',
  );
  await expect(ribbon.locator("[data-weather-city=\"odanak\"]")).toHaveAttribute(
    "href",
    "https://www.meteomedia.com/fr/ville/ca/quebec/odanak-12/actuelle",
  );
  await page.evaluate(() => {
    window.RadarTranslate = { ...(window.RadarTranslate || {}), getMode: () => 'en' };
    window.dispatchEvent(new CustomEvent('radar:translate-mode', { detail: { mode: 'en' } }));
  });
  const translatedPrimary = await activePrimary.evaluate((el) => ({ id: el.dataset.weatherCity, href: el.href }));
  expect(translatedPrimary.href).toBe(`https://www.meteomedia.com/fr/ville/ca/quebec/${translatedPrimary.id}/actuelle`);
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
  await page.waitForTimeout(100);
  await expect(ribbon).toBeVisible();
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(1);
  expect(await ribbon.locator('.masthead-weather__city.is-active').evaluateAll((cities) => cities.every((city) => {
    const name = city.querySelector('.masthead-weather__name');
    return !city.classList.contains('is-overflowing') && name.scrollWidth <= name.clientWidth + 2;
  }))).toBe(true);

  await page.setViewportSize({ width: 320, height: 900 });
  await expect(ribbon).toBeHidden();
});

test('météo téléphone : la carte unique parcourt les villes universitaires', async ({ page }) => {
  await stubForecast(page);

  // iPhone (390 pt de large).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const ribbon = page.locator('#masthead-weather');
  await expect(ribbon).toBeVisible();
  const active = ribbon.locator('.masthead-weather__city.is-active');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-weather-city', 'montreal');
  await expect(active.locator('.masthead-weather__temp')).not.toHaveText('—');

  // La date courte remplace la date longue et la rangée ne déborde pas.
  await expect(page.locator('.masthead-date__short')).toBeVisible();
  await expect(page.locator('.masthead-date__full')).toBeHidden();
  const actionsBox = await page.locator('.masthead-actions').boundingBox();
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(390);
  const [dateBox, weatherBox] = await Promise.all([
    page.locator('.masthead-date').boundingBox(), ribbon.boundingBox(),
  ]);
  expect(weatherBox.x).toBeGreaterThanOrEqual(dateBox.x + dateBox.width);
  expect(actionsBox.x).toBeGreaterThanOrEqual(weatherBox.x + weatherBox.width);

  // L'alternance dépasse Montréal/Québec : Sherbrooke puis Trois-Rivières
  // suivent l'ordre universitaire, sans que le nom déborde de la carte.
  await expect(active).toHaveAttribute('data-weather-city', 'quebec', { timeout: 7000 });
  await expect(active).toHaveAttribute('data-weather-city', 'sherbrooke', { timeout: 7000 });
  await expect(active).toHaveAttribute('data-weather-city', 'trois-rivieres', { timeout: 7000 });
  await expect(ribbon).toBeVisible();
  expect(await active.evaluate((city) => {
    const name = city.querySelector('.masthead-weather__name');
    return !city.classList.contains('is-overflowing') && name.scrollWidth <= name.clientWidth + 2;
  })).toBe(true);

  // Pixel 9 (412 pt de large) : même comportement.
  await page.setViewportSize({ width: 412, height: 924 });
  await page.waitForTimeout(150);
  await expect(ribbon).toBeVisible();
  await expect(ribbon.locator('.masthead-weather__city.is-active')).toHaveCount(1);
  const actionsBox412 = await page.locator('.masthead-actions').boundingBox();
  expect(actionsBox412.x + actionsBox412.width).toBeLessThanOrEqual(412);
});
