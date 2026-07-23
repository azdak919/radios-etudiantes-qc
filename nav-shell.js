/**
 * LE RADAR — Phase 2b navigation shell (same-tab continuous listening).
 *
 * While this top-level page is actually playing audio, internal navigations
 * (accueil, feeds, pomo, solitaire) load in a full-viewport iframe so the
 * host document — and its <audio> — stay alive. Child frames skip this module
 * (window !== top).
 *
 * Combined with Phase 1 sync: the iframe page becomes a follower UI; host keeps the stream.
 */
(function () {
  'use strict';

  if (window !== window.top) return;

  const FRAME_ID = 'radar-nav-frame';
  const SHELL_CLASS = 'radar-shell-active';
  const STYLE_ID = 'radar-nav-shell-style';

  function pathNorm(pathname) {
    let p = pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p || '/';
  }

  /** Paths we keep inside the shell (same-origin app surfaces). */
  function isShellPath(pathname) {
    const p = pathNorm(pathname);
    // Project pages on github.io: /le-radar, /le-radar/pomo, …
    const base = pathNorm(new URL('.', location.href).pathname);
    const rel = p === base ? '/' : (p.startsWith(base + '/') ? p.slice(base.length) : p);
    const r = rel.startsWith('/') ? rel : '/' + rel;
    if (r === '/' || r === '/index.html') return true;
    if (r === '/feeds.html' || r.endsWith('/feeds.html')) return true;
    if (r === '/pomo' || r.startsWith('/pomo/')) return true;
    if (r === '/solitaire' || r.startsWith('/solitaire/')) return true;
    return false;
  }

  function audioElPlaying(el) {
    return !!(el && el.src && !el.paused && !el.ended);
  }

  function isLocallyPlaying() {
    if (document.documentElement.dataset.radarPlaying === '1') return true;
    if (audioElPlaying(document.getElementById('radar-player'))) return true;

    // Pomo / Solitaire: the real player lives in the tuner embed iframe.
    const embeds = document.querySelectorAll(
      'iframe#radar-embed, iframe.radar-embed-frame, iframe[src*="tuner-embed"]'
    );
    for (const frame of embeds) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        if (doc.documentElement.dataset.radarPlaying === '1') return true;
        if (audioElPlaying(doc.getElementById('radar-player'))) return true;
      } catch {
        /* cross-origin — ignore */
      }
    }
    return false;
  }

  function shouldUseShell() {
    return isLocallyPlaying();
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      html.${SHELL_CLASS}, html.${SHELL_CLASS} body {
        overflow: hidden !important;
      }
      #${FRAME_ID} {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
        margin: 0;
        padding: 0;
        z-index: 2147483000;
        background: #0e1014;
      }
    `;
    document.head.appendChild(s);
  }

  function getFrame() {
    return document.getElementById(FRAME_ID);
  }

  function ensureFrame() {
    ensureStyles();
    let f = getFrame();
    if (!f) {
      f = document.createElement('iframe');
      f.id = FRAME_ID;
      f.title = 'Le Radar';
      f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
      f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      document.body.appendChild(f);
    }
    return f;
  }

  function exitShell({ restoreUrl } = {}) {
    const f = getFrame();
    if (f) f.remove();
    document.documentElement.classList.remove(SHELL_CLASS);
    if (restoreUrl) {
      try {
        history.replaceState({ radarShell: false }, '', restoreUrl);
      } catch { /* */ }
    }
  }

  function sameDocument(url) {
    try {
      const u = new URL(url, location.href);
      return (
        u.origin === location.origin
        && pathNorm(u.pathname) === pathNorm(location.pathname)
        && u.search === location.search
      );
    } catch {
      return false;
    }
  }

  function navigateInShell(href, { replace = false } = {}) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !isShellPath(url.pathname)) {
      location.href = href;
      return;
    }

    // Navigating "back" to the host page itself → just close the overlay.
    if (sameDocument(url.href)) {
      exitShell();
      if (!replace) {
        try { history.pushState({ radarShell: false }, '', url.href); } catch { /* */ }
      }
      return;
    }

    const f = ensureFrame();
    document.documentElement.classList.add(SHELL_CLASS);
    if (f.dataset.src !== url.href) {
      f.dataset.src = url.href;
      f.src = url.href;
    }
    try {
      const state = { radarShell: true, url: url.href };
      if (replace) history.replaceState(state, '', url.href);
      else history.pushState(state, '', url.href);
    } catch {
      /* ignore */
    }
  }

  function onClick(event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const a = event.target?.closest?.('a[href]');
    if (!a) return;
    if (a.hasAttribute('download')) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;

    let url;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    if (url.hash && pathNorm(url.pathname) === pathNorm(location.pathname) && url.search === location.search) {
      return; // in-page anchor
    }
    if (!isShellPath(url.pathname)) return;
    if (!shouldUseShell()) return;

    event.preventDefault();
    event.stopPropagation();
    navigateInShell(url.href);
  }

  function onPopState(event) {
    const st = event.state;
    if (st?.radarShell && st.url) {
      const f = ensureFrame();
      document.documentElement.classList.add(SHELL_CLASS);
      if (f.dataset.src !== st.url) {
        f.dataset.src = st.url;
        f.src = st.url;
      }
      return;
    }
    // Left shell history entry
    exitShell();
  }

  // If a child (iframe) wants to break out while host is still playing, it can
  // set location on top — we leave that to target=_top links.
  document.addEventListener('click', onClick, true);
  window.addEventListener('popstate', onPopState);

  // Expose tiny API for debugging / future controls
  window.RadarNavShell = {
    navigate: navigateInShell,
    exit: exitShell,
    isActive: () => document.documentElement.classList.contains(SHELL_CLASS),
  };
})();
