// Iframe embed (Solitaire, etc.) :
// hauteur fixe 58 px, volume en ligne, signale le parent via postMessage.
(function () {
  if (document.documentElement.dataset.embed !== 'tuner') return;

  const EMBED_H = 62; // aligné sur padding bureau 10+42+10

  // Hauteur souhaitée de l'iframe : hauteur de base, sauf quand le popover
  // volume (téléphone < 560 px) est ouvert — il déborde alors sous la rangée
  // et l'iframe doit s'agrandir pour ne pas le rogner.
  function desiredHeight() {
    const vol = document.getElementById('tuner-vol');
    if (!vol || !vol.classList.contains('is-open')) return EMBED_H;
    const slot = document.getElementById('tuner-vol-slot');
    // offsetHeight ignore le transform d'apparition (translateY/scale) :
    // la mesure est stable dès la première frame de l'animation.
    const anchor = vol.getBoundingClientRect().bottom;
    const slotH = slot?.offsetHeight || 0;
    return Math.max(EMBED_H, Math.ceil(anchor + 10 + slotH) + 8);
  }

  function postHeight(extra) {
    try {
      // La hauteur est toujours recalculée ici : un resize déclenché par
      // l'agrandissement de l'iframe (popover ouvert) doit renvoyer la hauteur
      // du popover, pas EMBED_H — sinon l'iframe rétrécit et rogne la bulle.
      const payload = {
        type: 'radar-embed',
        height: desiredHeight(),
        ready: true,
        ...(extra || {}),
      };
      parent.postMessage(payload, '*');
      // Legacy alias (pre-migration Ataraxia Solitaire listeners)
      parent.postMessage({ ...payload, type: 'ataraxia-radar-embed' }, '*');
    } catch (_) {}
  }

  // Classe utilitaire pour styles / debug parent
  document.documentElement.classList.add('is-radar-embed');

  // L'iframe doit suivre le bouton clair/sombre de la mini-app parente.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === 'radar-embed-theme' && (data.theme === 'light' || data.theme === 'dark')) {
      document.documentElement.dataset.theme = data.theme;
    }
  });

  window.addEventListener('load', () => postHeight({ event: 'load' }));
  window.addEventListener('resize', () => postHeight({ event: 'resize' }), { passive: true });

  // Embed étroit (< 560 px) : le volume s'ouvre en popover sous la rangée.
  // L'iframe est à hauteur fixe — on demande au parent la place du popover
  // le temps qu'il est ouvert, puis on revient à la hauteur de base.
  function watchVolumePopover() {
    const vol = document.getElementById('tuner-vol');
    if (!vol || typeof MutationObserver !== 'function') return;
    const syncHeight = () => {
      if (!vol.classList.contains('is-open')) {
        postHeight({ event: 'vol-close' });
        return;
      }
      // rAF : laisse le popover se poser avant de mesurer (desiredHeight).
      requestAnimationFrame(() => postHeight({ event: 'vol-open' }));
    };
    new MutationObserver(syncHeight).observe(vol, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchVolumePopover);
  } else {
    watchVolumePopover();
  }

  // Re-signal après hydratation du synthé (radios chargées)
  document.addEventListener('DOMContentLoaded', () => {
    postHeight({ event: 'dom' });
    // Petite latence : app.js (defer) peut peupler le dial juste après
    setTimeout(() => postHeight({ event: 'hydrate' }), 400);
  });
})();
