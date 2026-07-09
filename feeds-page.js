const TODAY_DATE = document.getElementById('today-date');
const THEME_TOGGLE = document.getElementById('theme-toggle');
const TOAST_EL = document.getElementById('toast');
const FEEDS_UPDATED = document.getElementById('feeds-updated');
const FEEDS_GRID_UNI = document.getElementById('feeds-grid-uni');
const FEEDS_GRID_CEGEP = document.getElementById('feeds-grid-cegep');
const FEEDS_CEGEP_WRAP = document.getElementById('feeds-cegep-wrap');
const FEEDS_GRID_NOTE = document.getElementById('feeds-grid-note');

const FEEDS_INSTITUTION_ACRONYMS = {
  'Université de Montréal': 'UdeM',
  UQAM: 'UQAM',
  'Université du Québec à Montréal': 'UQAM',
  'Université McGill': 'McGill',
  'McGill University': 'McGill',
  'Concordia University': 'Concordia',
  'Université Laval': 'ULaval',
  'Université de Sherbrooke': 'UdeS',
  'Université du Québec à Trois-Rivières': 'UQTR',
  'Polytechnique Montréal': 'Poly',
  "Bishop's University": "Bishop's",
  'Cégep du Vieux Montréal': 'CVM',
  'Cégep de Jonquière (ATM – journalisme)': 'Jonquière',
  'Cégep de Jonquière': 'Jonquière',
};

const FEEDS_INSTITUTION_ORDER = [
  'UdeM', 'UQAM', 'McGill', 'Concordia', 'ULaval', 'UdeS', 'UQTR', 'Poly', "Bishop's",
  'CVM', 'Jonquière',
];

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
  showToast._t = setTimeout(() => TOAST_EL.classList.add('hidden'), 2800);
}

function releaseFocus(el) {
  if (el && typeof el.blur === 'function') el.blur();
}

function initMastheadActions() {
  document.querySelectorAll('.masthead-actions .masthead-icon').forEach((el) => {
    const release = () => {
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.blur();
      });
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('click', release);
  });
}

async function copyFeedUrl(url, { toast = true } = {}) {
  try {
    await navigator.clipboard.writeText(url);
    if (toast) showToast('URL copiée dans le presse-papiers');
    return true;
  } catch {
    if (toast) showToast(url);
    return false;
  }
}

function prefersFeedProtocol() {
  return /firefox/i.test(navigator.userAgent);
}

/**
 * Déclenche l'abonnement de façon universelle :
 * - Web Share API (choix de l'app sur mobile)
 * - protocole feed: (lecteur RSS par défaut, ex. Firefox)
 * - copie de l'URL en dernier recours
 */
async function subscribeToFeed(url) {
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Le Radar — Fil étudiant',
        text: 'Fil RSS des médias étudiants du Québec',
        url,
      });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  if (prefersFeedProtocol()) {
    window.location.href = `feed:${url}`;
    return;
  }

  const copied = await copyFeedUrl(url, { toast: false });
  showToast(copied
    ? 'URL copiée — collez-la dans Inoreader, NetNewsWire ou votre lecteur RSS'
    : 'Copiez l\'URL du flux dans votre lecteur RSS');
}

function initFeedCards() {
  document.querySelectorAll('[data-feed]').forEach((card) => {
    const file = card.dataset.feed;
    const url = feedUrl(file);
    const code = card.querySelector('[data-feed-url]');
    const open = card.querySelector('[data-open]');
    const subscribeBtn = card.querySelector('[data-subscribe]');
    const copyBtn = card.querySelector('[data-copy]');

    if (code) code.textContent = url;
    if (open) open.href = url;

    subscribeBtn?.addEventListener('click', async () => {
      await subscribeToFeed(url);
      releaseFocus(subscribeBtn);
    });

    copyBtn?.addEventListener('click', async () => {
      await copyFeedUrl(url);
      releaseFocus(copyBtn);
    });
  });
}

function institutionAcronym(name = '') {
  if (!name) return '';
  if (FEEDS_INSTITUTION_ACRONYMS[name]) return FEEDS_INSTITUTION_ACRONYMS[name];
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (FEEDS_INSTITUTION_ACRONYMS[stripped]) return FEEDS_INSTITUTION_ACRONYMS[stripped];
  if (/^cégep\b/i.test(stripped)) return stripped.replace(/^Cégep\s+(de\s+|du\s+)?/i, '').split(/\s/)[0];
  return stripped.length > 18 ? `${stripped.slice(0, 16)}…` : stripped;
}

function institutionGroupKey(name = '') {
  return institutionAcronym(name) || name;
}

function institutionBrandColor(name = '', brandColors = {}) {
  const map = brandColors.institutions || {};
  return map[name]?.color
    || map[name?.replace(/\s*\([^)]*\)\s*$/, '').trim()]?.color
    || brandColors.fallback_palette?.[0]
    || '#003DA5';
}

function groupSourcesByInstitution(sources = []) {
  const groups = new Map();
  sources.forEach((src) => {
    const inst = String(src.institution || '').trim();
    if (!inst) return;
    const key = institutionGroupKey(inst);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        institution: inst,
        acronym: institutionAcronym(inst),
        type: src.type || 'universite',
        papers: [],
        minPopularity: 50,
      });
    }
    const g = groups.get(key);
    g.papers.push(src.name);
    g.minPopularity = Math.min(g.minPopularity, src.popularity ?? 50);
    if (src.type === 'cegep') g.type = 'cegep';
  });
  groups.forEach((g) => {
    g.papers.sort((a, b) => a.localeCompare(b, 'fr'));
  });
  return [...groups.values()];
}

function sortInstitutionGroups(groups = []) {
  return [...groups].sort((a, b) => {
    const typeDiff = (a.type === 'cegep' ? 1 : 0) - (b.type === 'cegep' ? 1 : 0);
    if (typeDiff !== 0) return typeDiff;
    const ai = FEEDS_INSTITUTION_ORDER.indexOf(a.key);
    const bi = FEEDS_INSTITUTION_ORDER.indexOf(b.key);
    const ar = ai >= 0 ? ai : 100 + a.minPopularity;
    const br = bi >= 0 ? bi : 100 + b.minPopularity;
    if (ar !== br) return ar - br;
    return a.acronym.localeCompare(b.acronym, 'fr');
  });
}

function renderFeedsGridRow(group, brandColors) {
  const li = document.createElement('li');
  li.className = 'feeds-grid__row';
  li.style.setProperty('--c', institutionBrandColor(group.institution, brandColors));

  const campus = document.createElement('span');
  campus.className = 'feeds-grid__campus';
  campus.textContent = group.acronym;

  const paper = document.createElement('span');
  paper.className = 'feeds-grid__paper';
  paper.textContent = group.papers.join(' · ');

  li.append(campus, paper);
  return li;
}

async function renderFeedsCampuses() {
  if (!FEEDS_GRID_UNI) return;
  try {
    const [registry, brandColors] = await Promise.all([
      fetch('./news-sources.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('./brand-colors.json', { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    const active = (registry?.active || []).filter((s) => s.name && s.institution);
    const groups = sortInstitutionGroups(groupSourcesByInstitution(active));
    const uni = groups.filter((g) => g.type !== 'cegep');
    const cegep = groups.filter((g) => g.type === 'cegep');

    FEEDS_GRID_UNI.replaceChildren(...uni.map((g) => renderFeedsGridRow(g, brandColors)));
    FEEDS_GRID_UNI.removeAttribute('aria-busy');

    if (FEEDS_GRID_CEGEP && cegep.length) {
      FEEDS_GRID_CEGEP.replaceChildren(...cegep.map((g) => renderFeedsGridRow(g, brandColors)));
      FEEDS_CEGEP_WRAP?.removeAttribute('hidden');
    }

    const candidates = registry?.candidates?.length || 0;
    if (FEEDS_GRID_NOTE && candidates > 0) {
      FEEDS_GRID_NOTE.textContent = `+ ${candidates} publication${candidates > 1 ? 's' : ''} en cours d'intégration au fil.`;
      FEEDS_GRID_NOTE.hidden = false;
    }
  } catch {
    FEEDS_GRID_UNI.removeAttribute('aria-busy');
    if (FEEDS_GRID_NOTE) {
      FEEDS_GRID_NOTE.textContent = 'Impossible de charger la liste des sources.';
      FEEDS_GRID_NOTE.hidden = false;
    }
  }
}

async function renderFeedsUpdated() {
  if (!FEEDS_UPDATED) return;
  try {
    const res = await fetch('./news.json', { cache: 'no-cache' });
    const data = await res.json();
    if (!data.updated) return;
    const d = new Date(data.updatedSlot || data.updated);
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
initMastheadActions();
renderTodayDate();
initFeedCards();
renderFeedsCampuses();
renderFeedsUpdated();