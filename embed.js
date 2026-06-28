// Iframe embed : hauteur dynamique vers le haut quand le popover volume est ouvert.
(function () {
  if (document.documentElement.dataset.embed !== 'tuner') return;

  const EMBED_VOL_COMPACT_MQ = window.matchMedia?.('(max-width: 559.98px)');

  function postHeight() {
    const tuner = document.getElementById('tuner');
    if (!tuner) return;

    const baseH = Math.ceil(tuner.getBoundingClientRect().height);
    let height = baseH;
    const vol = document.getElementById('tuner-vol');
    const slot = document.getElementById('tuner-vol-slot');
    const popoverOpen = !!(
      EMBED_VOL_COMPACT_MQ?.matches
      && vol?.classList.contains('is-open')
      && slot
    );

    if (popoverOpen) {
      const tunerRect = tuner.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      height = Math.ceil(tunerRect.bottom - Math.min(tunerRect.top, slotRect.top) + 8);
    }

    parent.postMessage({
      type: 'ataraxia-radar-embed',
      height,
      baseHeight: baseH,
      popoverOpen,
    }, '*');
  }

  function schedule() {
    requestAnimationFrame(() => requestAnimationFrame(postHeight));
  }

  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  EMBED_VOL_COMPACT_MQ?.addEventListener?.('change', schedule);

  const tuner = document.getElementById('tuner');
  if (tuner && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(tuner);
  }

  const vol = document.getElementById('tuner-vol');
  if (vol && typeof MutationObserver !== 'undefined') {
    new MutationObserver(schedule).observe(vol, { attributes: true, attributeFilter: ['class'] });
  }

  const slot = document.getElementById('tuner-vol-slot');
  if (slot && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(slot);
  }
})();