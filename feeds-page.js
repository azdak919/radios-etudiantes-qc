const TODAY_DATE = document.getElementById('today-date');
const THEME_TOGGLE = document.getElementById('theme-toggle');
const TOAST_EL = document.getElementById('toast');
const FEEDS_UPDATED = document.getElementById('feeds-updated');

function siteBase() {
  const path = window.location.pathname.replace(/\/[^/]*$/, '');
  return `${window.location.origin}${path}`.replace(/\/$/, '') || window.location.origin;
}

function feedUrl(file) {
  return `${siteBase()}/${file}`;
}

function initTheme() {
  const saved = localStorage.getItem('req-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  THEME_TOGGLE?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('req-theme', next);
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  THEME_TOGGLE?.querySelector('.ico-sun')?.classList.toggle('hidden', isDark);
  THEME_TOGGLE?.querySelector('.ico-moon')?.classList.toggle('hidden', !isDark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#0e0f12' : '#ffffff');
}

function renderTodayDate() {
  if (!TODAY_DATE) return;
  TODAY_DATE.textContent = new Date().toLocaleDateString('fr-CA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function showToast(msg) {
  if (!TOAST_EL) return;
  TOAST_EL.textContent = msg;
  TOAST_EL.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => TOAST_EL.classList.add('hidden'), 2200);
}

function initFeedCards() {
  document.querySelectorAll('.feed-card[data-feed]').forEach((card) => {
    const file = card.dataset.feed;
    const url = feedUrl(file);
    const code = card.querySelector('[data-feed-url]');
    const open = card.querySelector('[data-open]');
    const feedly = card.querySelector('[data-feedly]');
    const copyBtn = card.querySelector('[data-copy]');

    if (code) code.textContent = url;
    if (open) open.href = url;
    if (feedly) {
      feedly.href = `https://feedly.com/i/subscription/feed/${encodeURIComponent(url)}`;
    }
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        showToast('URL copiée dans le presse-papiers');
      } catch {
        showToast(url);
      }
    });
  });
}

async function renderFeedsUpdated() {
  if (!FEEDS_UPDATED) return;
  try {
    const res = await fetch('./news.json', { cache: 'no-cache' });
    const data = await res.json();
    if (!data.updated) return;
    const d = new Date(data.updated);
    const stamp = d.toLocaleString('fr-CA', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    FEEDS_UPDATED.textContent = `Dernière mise à jour du fil : ${stamp}`;
    FEEDS_UPDATED.hidden = false;
  } catch {
    /* optional */
  }
}

initTheme();
renderTodayDate();
initFeedCards();
renderFeedsUpdated();