/* Ataraxia — background loader & smart random selection
 * Depends: backgrounds-data.js, storage.js
 * Exports: loadBackground, nextBackground, getRandomBgIndex, recordBgSeen
 *
 * Randomness:
 *   • crypto-quality picks (crypto.getRandomValues)
 *   • long recent window + session "shuffle bag" (no reuse until bag empties)
 *   • diversify mood / source / photographer vs the last few shown
 *
 * Quality:
 *   • Unsplash: auto=format&fit=max&q=90, responsive w up to 2560
 *   • Pexels: tinysrgb + responsive w
 *   • Wikimedia: promote low-res thumbs to 1920px when possible
 */
let currentBgIdx = 0;
let recentBgs = [];
const BG_CROSSFADE_MS = 900;

/** Session bag of remaining indices (reshuffled when empty). */
let _bgBag = [];
/** Last few mood tags shown (for diversity). */
let _recentMoods = [];
/** Indices that failed to load this session (skip). */
const _failedBg = new Set();

function safeHttpsUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Uniform integer in [0, n) using crypto when available. */
function _randInt(n) {
  if (n <= 1) return 0;
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      // Rejection sampling avoids modulo bias for small n
      const max = 0x100000000;
      const limit = max - (max % n);
      let x;
      do {
        crypto.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % n;
    }
  } catch (_) {}
  return Math.floor(Math.random() * n);
}

function _shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = _randInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

// Return an appropriate image width for the current viewport + device pixel ratio.
// Allows sharp wallpapers on large desktops (up to 2560) while staying light on phones.
function _responsiveImgWidth() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vw = (window.innerWidth || screen.width || 1280) * dpr;
  if (vw <= 720)  return 800;
  if (vw <= 1100) return 1280;
  if (vw <= 1700) return 1920;
  if (vw <= 2400) return 2560;
  return 2560;
}

/**
 * Rewrite CDN URLs for sharper delivery without blowing phone bandwidth.
 * Base data uses w=1920 placeholders; we adapt at load time.
 */
function _optimizeBgUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  let url = rawUrl;
  const w = _responsiveImgWidth();

  if (url.includes('images.unsplash.com')) {
    try {
      const u = new URL(url);
      u.searchParams.set('w', String(w));
      u.searchParams.set('q', '90');
      u.searchParams.set('auto', 'format');
      u.searchParams.set('fit', 'max');
      // Prefer modern formats when supported; Unsplash imgix honors auto=format
      url = u.href;
    } catch (_) {
      url = url
        .replace(/([?&])w=\d+/g, `$1w=${w}`)
        .replace(/([?&])q=\d+/g, '$1q=90');
      if (!/[?&]auto=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'auto=format&fit=max';
    }
  } else if (url.includes('images.pexels.com')) {
    try {
      const u = new URL(url);
      u.searchParams.set('auto', 'compress');
      u.searchParams.set('cs', 'tinysrgb');
      u.searchParams.set('w', String(w));
      u.searchParams.delete('dpr'); // we bake DPR into w already
      url = u.href;
    } catch (_) {
      url = url.replace(/([?&])w=\d+/g, `$1w=${w}`);
      if (!/[?&]cs=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'cs=tinysrgb';
    }
  } else if (url.includes('upload.wikimedia.org')) {
    // Promote 800/1024 thumbs to 1920 for wallpapers (full-res originals are huge).
    url = url.replace(/\/(800|1024|1280)px-/g, '/1920px-');
  }

  return url;
}

/** Coarse mood from title/credit for diversity (not culture tags). */
function _bgMood(bg) {
  if (!bg) return 'other';
  if (bg.culture) return `c:${bg.culture}`;
  const t = `${bg.title || ''} ${bg.credit || ''}`.toLowerCase();
  if (/aurora|milky|star|night|galaxy|space|nocturne/.test(t)) return 'night';
  if (/ocean|sea|coast|beach|wave|shore|cliff/.test(t)) return 'ocean';
  if (/desert|dune|sand|canyon|arid/.test(t)) return 'desert';
  if (/snow|winter|ice|frost|glacier|alpine snow/.test(t)) return 'winter';
  if (/forest|tree|wood|pine|canopy|redwood|birch/.test(t)) return 'forest';
  if (/mountain|peak|summit|alps|himalaya|ridge/.test(t)) return 'mountain';
  if (/lake|river|waterfall|stream|pond/.test(t)) return 'water';
  if (/sunset|sunrise|dawn|dusk|golden|lavender|meadow|field/.test(t)) return 'golden';
  if (/fog|mist|cloud|haze|overcast/.test(t)) return 'mist';
  if (bg.source && /wikimedia|public domain/i.test(bg.source)) return 'art';
  return 'nature';
}

function _photographerKey(bg) {
  if (!bg) return '';
  // Prefer Unsplash/Pexels handle from link; else credit text
  try {
    if (bg.link) {
      const path = new URL(bg.link).pathname.replace(/\/+$/, '');
      const handle = path.split('/').filter(Boolean).pop();
      if (handle) return handle.toLowerCase();
    }
  } catch (_) {}
  return String(bg.credit || '').split('—')[0].trim().toLowerCase().slice(0, 40);
}

function showCreditsBar() {
  const bar = document.querySelector('.bottom-badges');
  if (!bar || bar.classList.contains('visible')) return;
  const pageStart = window._ataraxiaPageStart ?? 0;
  const minAt = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ui-delay-credits')
  ) * 1000 || 540;
  const wait = Math.max(0, minAt - (performance.now() - pageStart));
  setTimeout(() => {
    bar.classList.add('visible');
    requestAnimationFrame(() => window.AtaraxiaLayout?.updateChromeInsets?.());
  }, wait);
}

function loadBackground(index) {
  const bg = BACKGROUNDS[index];
  if (!bg) {
    _nextFromPool();
    return;
  }
  const url = _optimizeBgUrl(bg.url);
  _applyBackground(url, bg.credit, bg.link, bg.source || 'Unsplash', bg.title || '');
}

// Cleanup function for any in-progress background crossfade transition.
let _bgCrossfadeCleanup = null;
let _bgFadeTimer = null;

function _applyBackground(url, creditText, linkUrl, source, title = '') {
  const layerCurrent = document.getElementById('bg-layer');
  const layerNext    = document.getElementById('bg-layer-next');
  const credit       = document.getElementById('img-credit');

  const img = new Image();
  // Hint decoder for large wallpapers
  try { img.decoding = 'async'; } catch (_) {}
  img.onload = () => {
    // If a previous crossfade is still in progress, finalize it immediately so
    // layerCurrent is up-to-date before we start the next transition.
    if (_bgCrossfadeCleanup) {
      _bgCrossfadeCleanup();
      _bgCrossfadeCleanup = null;
    }

    // Snap the incoming layer to opacity 0 (bypass the CSS transition) and
    // load the new image onto it, then re-enable the transition and fade in.
    layerNext.style.transition = 'none';
    layerNext.classList.remove('loaded');
    layerNext.style.backgroundImage = `url(${url})`;
    layerNext.offsetHeight; // read layout to force reflow and commit opacity:0 before re-enabling the transition
    layerNext.style.transition = '';
    layerNext.classList.add('is-fading');
    requestAnimationFrame(() => { layerNext.classList.add('loaded'); });

    // Persist current background URL so /solitaire/ can share it
    try { localStorage.setItem('ataraxia_bg_url', url); } catch(e) {}

    // Safer DOM construction (was innerHTML). Prevents any future XSS risk and is more explicit.
    credit.textContent = '';
    const safeLink = safeHttpsUrl(linkUrl);
    if (source === 'Unsplash' || source === 'Pexels') {
      const titlePart = title ? `«${title}» · ` : '';
      credit.appendChild(document.createTextNode(`Photo: ${titlePart}`));
      if (safeLink) {
        const a = document.createElement('a');
        a.href = safeLink;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = creditText;
        credit.appendChild(a);
      } else {
        credit.appendChild(document.createTextNode(creditText));
      }
      credit.appendChild(document.createTextNode(` · ${source}`));
    } else if (safeLink) {
      const a = document.createElement('a');
      a.href = safeLink;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = creditText;
      credit.appendChild(a);
      credit.appendChild(document.createTextNode(` · ${source}`));
    } else {
      credit.appendChild(document.createTextNode(`${creditText} · ${source}`));
    }
    showCreditsBar();

    function finalizeCrossfade() {
      if (_bgFadeTimer) {
        clearTimeout(_bgFadeTimer);
        _bgFadeTimer = null;
      }
      layerNext.removeEventListener('transitionend', onTransitionEnd);
      _bgCrossfadeCleanup = null;
      layerCurrent.style.backgroundImage = `url(${url})`;
      layerNext.style.transition = 'none';
      layerNext.classList.remove('loaded', 'is-fading');
      layerNext.style.backgroundImage = '';
      requestAnimationFrame(() => { layerNext.style.transition = ''; });
    }

    function onTransitionEnd(e) {
      if (e.propertyName !== 'opacity' || e.target !== layerNext) return;
      finalizeCrossfade();
    }
    layerNext.addEventListener('transitionend', onTransitionEnd);
    _bgFadeTimer = setTimeout(finalizeCrossfade, BG_CROSSFADE_MS + 80);

    _bgCrossfadeCleanup = () => {
      finalizeCrossfade();
    };
  };
  img.onerror = () => {
    _failedBg.add(currentBgIdx);
    // Fallback to a randomly chosen pool entry to avoid always landing on the
    // same images when several consecutive entries in the list fail to load
    // (e.g. due to CDN hotlinking restrictions).
    _nextFromPool();
  };
  img.src = url;
}

function _nextFromPool() {
  const idx = getRandomBgIndex(null); // full pool, no culture preference
  currentBgIdx = idx;
  recordBgSeen(idx);
  loadBackground(idx);
}

function nextBackground() {
  _nextFromPool();
}

function recordBgSeen(idx) {
  recentBgs = recentBgs.filter(i => i !== idx);
  recentBgs.push(idx);
  if (recentBgs.length > MAX_RECENT_BGS) recentBgs.shift();
  try { localStorage.setItem(RECENT_BGS_KEY, JSON.stringify(recentBgs)); } catch(e) {}

  const mood = _bgMood(BACKGROUNDS[idx]);
  _recentMoods.push(mood);
  if (_recentMoods.length > 6) _recentMoods.shift();

  // Remove from session bag so we don't reshuffle into it mid-cycle
  _bgBag = _bgBag.filter(i => i !== idx);
}

/**
 * Refill the session bag with a Fisher–Yates shuffle of the pool,
 * preferring indices not in the long-term recent list when possible.
 */
function _refillBgBag(pool) {
  const avoid = new Set(recentBgs.slice(-MAX_RECENT_BGS));
  const fresh = pool.filter(i => !avoid.has(i) && !_failedBg.has(i));
  const base = fresh.length >= Math.min(12, pool.length)
    ? fresh
    : pool.filter(i => !_failedBg.has(i));
  const bag = base.length ? base.slice() : pool.slice();
  _shuffleInPlace(bag);
  _bgBag = bag;
}

/**
 * Score candidate: higher = better (less similar to recent history).
 */
function _scoreCandidate(idx) {
  const bg = BACKGROUNDS[idx];
  let score = 10 + _randInt(5); // small jitter

  const mood = _bgMood(bg);
  // Soft fog/cloud stock is less engaging as a wallpaper — deprioritize.
  if (mood === 'mist') score -= 5;
  // Penalize moods seen in the last few picks
  for (let k = 0; k < _recentMoods.length; k++) {
    if (_recentMoods[_recentMoods.length - 1 - k] === mood) {
      score -= (6 - k); // more recent match → heavier penalty
    }
  }

  // Avoid same photographer twice in a row
  if (recentBgs.length) {
    const last = BACKGROUNDS[recentBgs[recentBgs.length - 1]];
    if (_photographerKey(bg) && _photographerKey(bg) === _photographerKey(last)) {
      score -= 8;
    }
  }

  // Light source diversity: don't chain Wikimedia art only, or only Pexels
  if (recentBgs.length >= 2) {
    const lastSrc = (BACKGROUNDS[recentBgs[recentBgs.length - 1]]?.source || '').split('·')[0].trim();
    const src = (bg.source || '').split('·')[0].trim();
    if (lastSrc && src && lastSrc === src) score -= 2;
  }

  // Prefer never-seen-in-recent slightly
  if (!recentBgs.includes(idx)) score += 3;

  return score;
}

function getRandomBgIndex(culture = null) {
  let pool = Array.from({ length: BACKGROUNDS.length }, (_, i) => i)
    .filter(i => !_failedBg.has(i));

  if (culture) {
    // Respect cultural preference (same logic as before, but on full pool first)
    const fallbacks = { 'east-asian': 'japanese', 'modern': null };
    const resolved = fallbacks[culture] !== undefined ? (fallbacks[culture] || culture) : culture;

    let cultPool = pool.filter(i => BACKGROUNDS[i].culture === resolved);
    if (cultPool.length === 0 && resolved !== culture) {
      cultPool = pool.filter(i => BACKGROUNDS[i].culture === culture);
    }
    if (cultPool.length === 0) {
      cultPool = pool.filter(i => !BACKGROUNDS[i].culture); // untagged nature
    }
    if (cultPool.length > 0) pool = cultPool;
  }

  if (!pool.length) {
    pool = Array.from({ length: BACKGROUNDS.length }, (_, i) => i);
  }

  // Culture-scoped picks don't use the global bag (small pool)
  if (culture) {
    const avoid = new Set(recentBgs.slice(-Math.min(MAX_RECENT_BGS, Math.max(3, pool.length - 1))));
    let candidates = pool.filter(i => !avoid.has(i) && i !== currentBgIdx);
    if (candidates.length < 2) candidates = pool.filter(i => i !== currentBgIdx);
    if (!candidates.length) candidates = pool.slice();
    // Weighted pick by diversity score
    let best = candidates[0];
    let bestScore = -Infinity;
    // Sample up to 12 candidates for quality without scanning huge pools
    const sample = candidates.length <= 12
      ? candidates
      : _shuffleInPlace(candidates.slice()).slice(0, 12);
    for (const i of sample) {
      const s = _scoreCandidate(i);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  // Main path: session bag + scored pick among bag head
  _bgBag = _bgBag.filter(i => pool.includes(i) && i !== currentBgIdx && !_failedBg.has(i));
  if (_bgBag.length < 3) {
    _refillBgBag(pool);
    _bgBag = _bgBag.filter(i => i !== currentBgIdx);
    if (!_bgBag.length) _refillBgBag(pool);
  }

  // Take a window from the bag and pick the highest-scoring (diverse) index
  const windowSize = Math.min(10, _bgBag.length);
  const window = _bgBag.slice(0, windowSize);
  let best = window[0];
  let bestScore = -Infinity;
  for (const i of window) {
    const s = _scoreCandidate(i);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }

  // Remove chosen from bag
  _bgBag = _bgBag.filter(i => i !== best);

  if (best === currentBgIdx && pool.length > 1) {
    const alt = pool.find(i => i !== currentBgIdx) ?? best;
    return alt;
  }
  return best;
}
