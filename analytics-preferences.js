/*
 * Opt-out analytics local, avant le chargement d'Umami.
 *
 * Usage :
 *   ?analytics=off  ne plus compter ce navigateur pour ce domaine
 *   ?analytics=on   réactiver la mesure
 *
 * Umami reconnaît nativement la clé `umami.disabled`.
 */
(() => {
  try {
    const url = new URL(window.location.href);
    const preference = url.searchParams.get('analytics');
    if (preference !== 'off' && preference !== 'on') return;

    if (preference === 'off') localStorage.setItem('umami.disabled', '1');
    else localStorage.removeItem('umami.disabled');

    url.searchParams.delete('analytics');
    // Solitaire utilise aussi un identifiant global `history` pour les coups.
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* navigation privée ou navigateur ancien */ }
})();
