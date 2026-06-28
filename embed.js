// Iframe embed : hauteur fixe (barre synthé 58 px, volume en ligne).
(function () {
  if (document.documentElement.dataset.embed !== 'tuner') return;

  const EMBED_H = 58;

  function postHeight() {
    parent.postMessage({ type: 'ataraxia-radar-embed', height: EMBED_H }, '*');
  }

  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);
})();