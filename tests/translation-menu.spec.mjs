import { expect, test } from '@playwright/test';

const pages = [
  { path: '/', button: '#translate-toggle' },
  { path: '/pomo/', button: '#lang-btn', anchor: '.top-right-actions' },
  { path: '/solitaire/', button: '#lang-btn', anchor: '.game-toolbar' },
];

for (const viewport of [
  { name: 'bureau', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  for (const app of pages) {
    test(`menu de traduction partagé — ${viewport.name} ${app.path}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(app.path, { waitUntil: 'domcontentloaded' });
      await page.locator(app.button).click();

      const menu = page.locator('.translate-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('.translate-menu__search')).toBeVisible();
      expect(await menu.locator('.translate-menu__opt').count()).toBeGreaterThan(40);
      await expect(menu.locator('[data-mode="fr"]')).toBeVisible();
      await expect(menu.locator('.translate-menu__group[data-group="indigenous"]')).toBeVisible();
      await expect(menu.locator('[data-mode="original"] .translate-menu__hint')).toContainText(/traduction|translation/i);

      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      if (app.anchor) {
        const anchorBounds = await page.locator(app.anchor).boundingBox();
        expect(anchorBounds).not.toBeNull();
        expect(bounds.y).toBeGreaterThanOrEqual(anchorBounds.y + anchorBounds.height - 1);
        const weight = await menu.locator('[data-mode="original"] .translate-menu__name')
          .evaluate((element) => Number.parseInt(getComputedStyle(element).fontWeight, 10));
        expect(weight).toBeLessThanOrEqual(500);
        if (viewport.width <= 600) {
          await expect(page.locator(`${app.button} .translate-toggle__label`)).toBeHidden();
          await expect(page.locator(`${app.button} .translate-toggle__chev`)).toBeHidden();
        }
      }

      await menu.locator('.translate-menu__search').fill('japonais');
      await expect(menu.locator('[data-mode="ja"]')).toBeVisible();
      await expect(menu.locator('[data-mode="es"]')).toBeHidden();
    });
  }
}

test('la préférence choisie dans Pomo est reprise dans Solitaire', async ({ page }) => {
  await page.goto('/pomo/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('#lang-btn').click();
  await page.locator('#lang-dropdown [data-mode="fr"]').click();
  await expect(page.locator('#lang-label')).toHaveText('FR');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('radar-translate-mode'))).toBe('fr');

  await page.goto('/solitaire/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#lang-label')).toHaveText('FR');
  await expect(page.locator('#new-game-label')).toHaveText('Nouvelle partie');
});

test('Pomo applique la phase traduite dès la fin de la traduction asynchrone', async ({ page }) => {
  await page.route('https://api.mymemory.translated.net/**', async (route) => {
    const source = new URL(route.request().url()).searchParams.get('q') || '';
    const translated = source === 'Focus' ? 'ᑐᕌᒐᖅ' : `IU ${source}`;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        responseStatus: 200,
        responseData: { translatedText: translated },
      }),
    });
  });

  await page.goto('/pomo/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#lang-btn').click();
  await page.locator('#lang-dropdown [data-mode="iu"]').click();

  await expect(page.locator('#pomo-label')).toHaveText('ᑐᕌᒐᖅ');
  await expect(page).toHaveTitle(/ᑐᕌᒐᖅ/);
});
