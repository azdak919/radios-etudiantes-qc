/* Bandeau météo compact du menu Pomodoro — Open-Meteo, sans clé API. */
(() => {
  const board = document.querySelector('[data-weather-board]');
  if (!board) return;
  let cities = [
    { id: 'montreal', name: 'Montréal', lat: 45.5017, lon: -73.5673 },
    { id: 'quebec', name: 'Québec', lat: 46.8139, lon: -71.2080 },
    { id: 'sherbrooke', name: 'Sherbrooke', lat: 45.4042, lon: -71.8929 },
    { id: 'saguenay', name: 'Saguenay', lat: 48.4280, lon: -71.0686 },
  ];
  const nationIds = new Set(['odanak', 'kitigan-zibi', 'manawan', 'nemaska', 'wendake', 'uashat', 'kuujjuaq', 'cacouna', 'gesgapegiag', 'kahnawake', 'kawawachikamach']);
  let rotationIndex = 0;
  let latestEntries = null;
  const secondaryOffsets = [0, 1, 2];
  const slotTimers = [];
  // Le catalogue de référence reste celui du Radar principal. On le lit
  // depuis app.js pour éviter de maintenir une seconde liste de 47 villes.
  async function importMainCityCatalog() {
    try {
      const source = await fetch('../app.js', { credentials: 'same-origin' }).then(r => r.text());
      const block = source.match(/const WEATHER_CITIES = \[(.*?)\n\];/s)?.[1] || '';
      const imported = [...block.matchAll(/\{ id: '([^']+)', name: '([^']+)'[^\n]*?lat: ([\d.-]+), lon: ([\d.-]+)/g)]
        .map(m => ({ id: m[1], name: m[2], lat: Number(m[3]), lon: Number(m[4]), nation: nationIds.has(m[1]) }));
      if (imported.length >= 10) cities = imported;
    } catch (_) { /* les quatre villes prioritaires restent disponibles */ }
  }
  const icon = (code, day) => {
    if (code === 0) return day ? '☀️' : '🌙';
    if ([1, 2].includes(code)) return '🌤️';
    if (code === 3) return '☁️';
    if ([45, 48].includes(code)) return '≋';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄';
    if ([95, 96, 99].includes(code)) return '⚡';
    return '☂';
  };
  const weatherSlugs = {
    odanak: 'odanak-12', 'kitigan-zibi': 'kitigan-zibi', manawan: 'manouane', nemaska: 'nemaska',
    wendake: 'wendake', uashat: 'uashat', kuujjuaq: 'kuujjuaq', cacouna: 'cacouna',
    gesgapegiag: 'gesgapegiag-2', kahnawake: 'kahnawake-14', kawawachikamach: 'kawawachikamach',
    'vaudreuil-soulanges': 'vaudreuil-dorion',
  };
  const weatherUrl = (city) => {
    const slug = weatherSlugs[city.id] || city.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`]/g, '').replace(/[–—]/g, '-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `https://www.meteomedia.com/fr/ville/ca/quebec/${slug}/actuelle`;
  };
  const render = (data) => {
    const list = Array.isArray(data) ? data : [data];
    latestEntries = list;
    const card = (item, city, extra = '') => {
      const current = item?.current || {};
      const temp = Number.isFinite(current.temperature_2m) ? `${Math.round(current.temperature_2m)}°` : '—';
      return `<a class="pomo-weather-city${extra}" data-weather-city="${city.id}" href="${weatherUrl(city)}" target="_blank" rel="noopener noreferrer" title="Prévisions MétéoMédia — ${city.name}"><span class="pomo-weather-icon" aria-hidden="true">${icon(current.weather_code, current.is_day)}</span><span class="pomo-weather-name">${city.name}</span><strong class="pomo-weather-temp">${temp}</strong></a>`;
    };
    const primaryIndex = rotationIndex % 2;
    const primaryItem = list[primaryIndex];
    const primaryCity = cities[primaryIndex];
    const desired = primaryItem && primaryCity
      ? [{ item: primaryItem, city: primaryCity, extra: ' pomo-weather-city--primary' }]
      : [];
    const secondary = list.slice(2);
    const visible = Array.from({ length: Math.min(3, secondary.length) }, (_, i) => {
      // Slot central : une ville des Premières Nations / Inuit / Métis.
      // Les deux autres slots restent réservés aux pôles régionaux.
      const pool = secondary.map((item, index) => ({ item, city: cities[index + 2] }))
        .filter(({ city }) => i === 1 ? city.nation : !city.nation);
      const index = (secondaryOffsets[i] + i) % Math.max(1, pool.length);
      return pool[index] || { item: secondary[(secondaryOffsets[i] + i) % secondary.length], city: cities[(secondaryOffsets[i] + i) % secondary.length + 2] };
    });
    desired.push(...visible.map(({ item, city }) => ({ item, city, extra: '' })));
    desired.forEach(({ item, city, extra }, index) => {
      const current = board.children[index];
      if (current?.dataset.weatherCity === city.id) return;
      const holder = document.createElement('div');
      holder.innerHTML = card(item, city, extra);
      const next = holder.firstElementChild;
      if (current) current.replaceWith(next);
      else board.append(next);
    });
    while (board.children.length > desired.length) board.lastElementChild.remove();
  };
  const forecast = () => {
    const params = new URLSearchParams({
    latitude: cities.map(c => c.lat).join(','), longitude: cities.map(c => c.lon).join(','),
    current: 'temperature_2m,weather_code,is_day', temperature_unit: 'celsius', timezone: 'America/Toronto',
    });
    return fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { credentials: 'omit' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('weather')))
    .then(render)
    .catch(() => { board.innerHTML = '<span class="pomo-weather-loading">Météo indisponible</span>'; });
  };
  const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const scheduleSlot = (slot) => {
    // Le Pomodoro privilégie la concentration : le bandeau principal reste
    // plus vivant, tandis qu'ici les changements sont espacés et discrets.
    const delay = slot === 0 ? randomBetween(45000, 70000) : randomBetween(70000, 110000);
    slotTimers[slot] = setTimeout(() => {
      if (slot === 0) rotationIndex = rotationIndex === 0 ? 1 : 0;
      else if (latestEntries) {
        const length = Math.max(1, latestEntries.slice(2).filter((_, index) => {
          const city = cities[index + 2];
          return slot === 2 ? city?.nation : !city?.nation;
        }).length);
        secondaryOffsets[slot - 1] = (secondaryOffsets[slot - 1] + randomBetween(1, Math.max(1, length - 1))) % length;
      }
      if (latestEntries) render(latestEntries);
      scheduleSlot(slot);
    }, delay);
  };
  importMainCityCatalog().then(() => {
    forecast();
    [0, 1, 2, 3].forEach(scheduleSlot);
  });
  setInterval(forecast, 15 * 60 * 1000);
})();
