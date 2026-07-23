import { expect, test } from '@playwright/test';

test('le panneau À l’antenne reste bleu lorsque le synthétiseur est arrêté', async ({ page }) => {
  await page.goto('/pomo/', { waitUntil: 'domcontentloaded' });
  const tuner = page.locator('#radar-embed').contentFrame();
  const colors = await tuner.locator('#tuner-nowair-title').evaluate((title) => {
    const radio = title.closest('.tuner');
    const panel = title.closest('.tuner-nowair');
    panel.classList.add('is-live');
    radio.classList.remove('is-playing');
    const idle = getComputedStyle(title).color;
    radio.classList.add('is-playing');
    const playing = getComputedStyle(title).color;
    return { idle, playing };
  });
  expect(colors.idle).not.toBe(colors.playing);
});

test('l’iframe alterne les postes affichés lorsque la radio est arrêtée', async ({ page }) => {
  await page.goto('/pomo/', { waitUntil: 'domcontentloaded' });
  const tuner = page.locator('#radar-embed').contentFrame();
  const title = tuner.locator('#tuner-nowair-title');
  await expect(title).not.toHaveText('');
  const first = await title.textContent();

  await expect.poll(() => title.textContent(), { timeout: 11_000 })
    .not.toBe(first);
});

test('Pomodoro garde son document hôte pendant une navigation avec lecture active', async ({ page }) => {
  await page.goto('/pomo/', { waitUntil: 'domcontentloaded' });
  const tuner = page.locator('#radar-embed').contentFrame();
  await expect(tuner.locator('#tuner-play')).toBeVisible();

  // Simule le signal posé par le lecteur après un play() réussi. Le test ne
  // dépend ainsi d'aucun flux radio externe ni des règles d'autoplay du CI.
  await tuner.locator('html').evaluate((html) => {
    html.dataset.radarPlaying = '1';
  });

  await page.locator('#solitaire-btn').click();
  await expect(page).toHaveURL(/\/solitaire\/?$/);
  await expect(page.locator('#pomo-container')).toBeAttached();

  const shell = page.locator('#radar-nav-frame');
  await expect(shell).toBeVisible();
  await expect(shell.contentFrame().locator('.page-layout')).toBeVisible();

  // Les liens de la page enfant repassent par l'hôte : une seule iframe,
  // l'URL correspond à la page visible et le lecteur hôte n'est pas recréé.
  await shell.contentFrame().locator('#radar-btn').evaluate((link) => link.click());
  await expect(page).toHaveURL(/\/$/);
  await expect(shell).toHaveCount(1);
  await expect(shell.contentFrame().locator('#tuner')).toBeVisible();

});

test('un seul leader radio est partagé entre deux pages', async ({ page, context }) => {
  const peer = await context.newPage();
  await Promise.all([
    page.goto('/', { waitUntil: 'domcontentloaded' }),
    peer.goto('/pomo/', { waitUntil: 'domcontentloaded' }),
  ]);

  const peerTuner = peer.locator('#radar-embed').contentFrame();
  await expect(peerTuner.locator('#tuner-play')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(window.RadarPlayerSync))).toBe(true);
  await expect.poll(() => peerTuner.locator('html').evaluate(() => Boolean(window.RadarPlayerSync))).toBe(true);

  const firstLeader = await page.evaluate(() => {
    window.RadarPlayerSync.claimPlay('chyz', 0.65);
    return window.RadarPlayerSync.getTabId();
  });

  await expect.poll(() => peerTuner.locator('html').evaluate(() =>
    window.RadarPlayerSync.readState())).toMatchObject({
    stationId: 'chyz',
    playing: true,
    volume: 0.65,
    leaderId: firstLeader,
  });

  const secondLeader = await peerTuner.locator('html').evaluate(() => {
    window.RadarPlayerSync.claimPlay('cism', 0.4);
    return window.RadarPlayerSync.getTabId();
  });
  expect(secondLeader).not.toBe(firstLeader);

  await expect.poll(() => page.evaluate(() =>
    window.RadarPlayerSync.readState())).toMatchObject({
    stationId: 'cism',
    playing: true,
    volume: 0.4,
    leaderId: secondLeader,
  });
});
