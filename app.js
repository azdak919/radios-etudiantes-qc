// RÉQ - Radios Étudiantes du Québec
// Clean, beautiful, mobile-first directory + player

// === STREAM PROXY CONFIG ===
// Leave as '' to use direct streams (best performance when they are HTTPS).
//
// To listen to almost all stations directly on this site (instead of the
// official radio websites), deploy the proxy once:
//
//   1. Copy proxy/cloudflare-worker.js
//   2. Paste it into a new Cloudflare Worker (free)
//   3. Deploy → you get https://something.workers.dev
//   4. Put that URL here:
//
// const PROXY_BASE = 'https://req-streams.yourname.workers.dev';
const PROXY_BASE = '';

function getPlayableStream(radio) {
  if (!radio?.stream) return null;
  const url = radio.stream;
  // HTTP stream on an HTTPS page → blocked by browser (mixed content); treat as no stream
  if (url.startsWith('http:') && location.protocol === 'https:' && !PROXY_BASE) return null;
  if (!PROXY_BASE) return url;
  return `${PROXY_BASE}/?url=${encodeURIComponent(url)}`;
}

const GRID = document.getElementById("radios-grid");
const SEARCH = document.getElementById("search-input");
const TYPE_FILTERS = document.getElementById("type-filters");
const REGION_CONTAINER = document.getElementById("region-filters");
const RESULTS_COUNT = document.getElementById("results-count");
const EMPTY = document.getElementById("empty-state");
const CLEAR_BTN = document.getElementById("clear-filters");
const RANDOM_BTN = document.getElementById("random-btn");
const MODAL = document.getElementById("modal");
const MODAL_PANEL = document.getElementById("modal-panel");
const INSTALL_BTN = document.getElementById("install-button");
const TOAST_EL = document.getElementById("toast");

let radios = [];
let currentFilters = { type: "all", regions: new Set(), query: "", showFavorites: false };
let currentRadio = null;
let audio = null;
let isPlaying = false;
let deferredInstallPrompt = null;

// Bootstrap
init();

async function init() {
  try {
    const res = await fetch("./radios.json");
    radios = await res.json();
  } catch (e) {
    console.error("Failed to load radios.json", e);
    radios = [];
  }

  renderRegions();
  bindFilters();
  bindSearch();
  bindGlobalActions();

  renderGrid();

  bindInstallFlow();
  setupAudio();

  // Keyboard niceties
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== SEARCH) {
      e.preventDefault();
      SEARCH.focus();
    }
    if (e.key === "Escape" && !MODAL.classList.contains("hidden")) {
      closeModal();
    }
  });

  // Close modal on outside click
  MODAL.addEventListener("click", (e) => {
    if (e.target === MODAL) closeModal();
  });

  // Seed a default region filter on mobile for discoverability (optional)
}

function renderRegions() {
  const regions = [...new Set(radios.map(r => r.region))].sort();
  REGION_CONTAINER.innerHTML = "";

  const allPill = createRegionPill("Toutes les régions", true);
  allPill.onclick = () => {
    currentFilters.regions.clear();
    updateRegionPills();
    renderGrid();
  };
  REGION_CONTAINER.appendChild(allPill);

  regions.forEach(region => {
    const pill = createRegionPill(region);
    pill.onclick = () => {
      if (currentFilters.regions.has(region)) {
        currentFilters.regions.delete(region);
      } else {
        currentFilters.regions.add(region);
      }
      updateRegionPills();
      renderGrid();
    };
    REGION_CONTAINER.appendChild(pill);
  });
}

function createRegionPill(label, isAll = false) {
  const el = document.createElement("div");
  el.className = `region-pill ${isAll ? "active" : ""}`;
  el.textContent = label;
  el.dataset.region = isAll ? "all" : label;
  return el;
}

function updateRegionPills() {
  [...REGION_CONTAINER.children].forEach(pill => {
    const r = pill.dataset.region;
    if (r === "all") {
      pill.classList.toggle("active", currentFilters.regions.size === 0);
    } else {
      pill.classList.toggle("active", currentFilters.regions.has(r));
    }
  });
}

function bindFilters() {
  TYPE_FILTERS.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.id === "fav-filter-btn") {
        // Toggle favorites-only mode
        currentFilters.showFavorites = !currentFilters.showFavorites;
        btn.classList.toggle("active", currentFilters.showFavorites);
        renderGrid();
        return;
      }

      TYPE_FILTERS.querySelectorAll("button").forEach(b => {
        if (b.id !== "fav-filter-btn") b.classList.remove("active");
      });
      btn.classList.add("active");
      currentFilters.type = btn.dataset.type;
      currentFilters.showFavorites = false;
      document.getElementById("fav-filter-btn")?.classList.remove("active");
      renderGrid();
    });
  });

  CLEAR_BTN?.addEventListener("click", () => {
    resetFilters();
  });
}

function bindSearch() {
  let t;
  SEARCH.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      currentFilters.query = SEARCH.value.trim().toLowerCase();
      renderGrid();
    }, 120);
  });
}

function resetFilters() {
  currentFilters = { type: "all", regions: new Set(), query: "", showFavorites: false };
  SEARCH.value = "";

  TYPE_FILTERS.querySelectorAll("button").forEach(b => b.classList.remove("active"));
  TYPE_FILTERS.querySelector('[data-type="all"]').classList.add("active");
  document.getElementById("fav-filter-btn")?.classList.remove("active");

  updateRegionPills();
  renderGrid();
}

function bindGlobalActions() {
  RANDOM_BTN.addEventListener("click", () => {
    if (!radios.length) return;
    const filtered = getFilteredRadios();
    const pool = filtered.length ? filtered : radios;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    openModal(pick);
  });
}

function getFilteredRadios() {
  const favs = getFavorites();
  return radios.filter(r => {
    const matchesType =
      currentFilters.type === "all" ||
      r.type === currentFilters.type;

    const matchesRegion =
      currentFilters.regions.size === 0 ||
      currentFilters.regions.has(r.region);

    const q = currentFilters.query;
    const matchesQuery =
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.fullName.toLowerCase().includes(q) ||
      r.institution.toLowerCase().includes(q) ||
      r.city.toLowerCase().includes(q) ||
      (r.description && r.description.toLowerCase().includes(q));

    const matchesFav = !currentFilters.showFavorites || favs.includes(r.id);

    return matchesType && matchesRegion && matchesQuery && matchesFav;
  });
}

function renderGrid() {
  const filtered = getFilteredRadios();
  GRID.innerHTML = "";
  EMPTY.classList.toggle("hidden", filtered.length > 0);

  RESULTS_COUNT.textContent = `${filtered.length} radio${filtered.length > 1 ? "s" : ""}`;

  filtered.forEach(radio => {
    const card = createRadioCard(radio);
    GRID.appendChild(card);
  });
}

function createRadioCard(radio) {
  const el = document.createElement("div");
  el.className = "radio-card glass flex flex-col gap-3 rounded-3xl p-4 cursor-pointer border border-white/10";

  const hasStream = !!getPlayableStream(radio);
  const initials = getInitials(radio.name);
  const isFav = getFavorites().includes(radio.id);

  el.innerHTML = `
    <div class="flex items-start gap-3">
      ${radio.logo 
        ? `<img src="${radio.logo}" alt="${radio.name}" class="station-logo ring-1 ring-white/15" loading="lazy">` 
        : `<div class="logo-badge ${radio.id} h-12 w-12 shrink-0 text-base ring-1 ring-white/15" aria-hidden="true">${initials}</div>`
      }
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-lg leading-none tracking-tight">${radio.name}</div>
            <div class="mt-0.5 text-sm text-white/65">${radio.frequency} • ${radio.city}</div>
          </div>
          <div class="flex items-center gap-1.5">
            ${hasStream ? `<div class="live-pill text-[10px] font-bold px-2 py-px self-start mt-0.5">LIVE</div>` : ""}
            <span class="fav-star text-lg leading-none ${isFav ? "text-rose-400" : "text-white/30"}" title="${isFav ? "Favori" : ""}">♥</span>
          </div>
        </div>
        <div class="mt-2 text-sm text-white/80 line-clamp-1">${radio.institution}</div>
      </div>
    </div>

    <div class="flex items-center justify-between pt-1">
      <div class="flex items-center gap-1.5 text-xs">
        <span class="rounded-full bg-white/5 px-2.5 py-0.5 text-white/60">${radio.type === "universite" ? "Université" : "Cégep"}</span>
      </div>

      <div class="flex items-center gap-1.5">
        <button class="listen-btn px-3 py-1.5 text-xs font-semibold rounded-2xl border border-white/15 bg-white/5 active:bg-white/10 transition"
                data-action="listen">
          ${hasStream ? "Écouter" : "Site"}
        </button>
        <button class="px-2.5 py-1.5 text-xs font-medium rounded-2xl border border-white/10 hover:bg-white/5 transition" data-action="details">
          Détails
        </button>
      </div>
    </div>
  `;

  // Card click opens modal
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-action]")) return;
    openModal(radio);
  });

  // Buttons
  const listenBtn = el.querySelector('[data-action="listen"]');
  const detailsBtn = el.querySelector('[data-action="details"]');

  listenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (radio.stream) {
      openModal(radio);
      // Auto play shortly after open
      setTimeout(() => playRadio(radio), 380);
    } else {
      window.open(radio.website, "_blank");
    }
  });

  detailsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal(radio);
  });

  return el;
}

function getInitials(name) {
  return name
    .split(/[\s.-]+/)
    .map(w => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function openModal(radio) {
  currentRadio = radio;
  const hasStream = !!getPlayableStream(radio);

  const socials = [];
  if (radio.instagram) socials.push(`<a href="${radio.instagram}" target="_blank" class="modal-btn flex-1 text-center text-sm border border-white/10 rounded-2xl py-3 hover:bg-white/5">Instagram</a>`);
  if (radio.facebook) socials.push(`<a href="${radio.facebook}" target="_blank" class="modal-btn flex-1 text-center text-sm border border-white/10 rounded-2xl py-3 hover:bg-white/5">Facebook</a>`);
  if (radio.website) socials.push(`<a href="${radio.website}" target="_blank" class="modal-btn flex-1 text-center text-sm border border-white/10 rounded-2xl py-3 hover:bg-white/5">Site web</a>`);

  MODAL_PANEL.innerHTML = `
    <div class="p-5 sm:p-7">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-4">
          ${radio.logo 
            ? `<img src="${radio.logo}" alt="${radio.name}" class="station-logo-modal ring-1 ring-white/15">` 
            : `<div class="logo-badge ${radio.id} h-16 w-16 text-2xl ring-1 ring-white/20">${getInitials(radio.name)}</div>`
          }
          <div>
            <div class="font-display text-3xl font-semibold tracking-[-1.5px]">${radio.fullName}</div>
            <div class="text-white/65 mt-0.5">${radio.institution} — ${radio.city}</div>
            <div class="mt-1 flex items-center gap-2 text-xs">
              <span class="rounded-full bg-white/5 px-2.5 py-[1px] text-white/75">${radio.frequency}</span>
              <span class="rounded-full bg-white/5 px-2.5 py-[1px] text-white/75">${radio.type === "universite" ? "Université" : "Cégep"}</span>
              ${hasStream ? `<span class="live-pill px-2 py-px text-[10px]">EN DIRECT</span>` : ""}
            </div>
          </div>
        </div>
        <button id="modal-close" class="text-3xl leading-none text-white/40 hover:text-white p-1 -mr-2">×</button>
      </div>

      <!-- Description -->
      <p class="mt-5 text-[15px] leading-relaxed text-white/80">${radio.description || "Radio étudiante du Québec."}</p>

      <!-- Player area -->
      <div class="mt-6 rounded-3xl border border-white/20 bg-black/70 p-4">
        <div class="mb-3 flex items-center justify-between px-1">
          <div>
            <div class="text-xs uppercase tracking-[1.5px] text-white/45">Écoute en direct</div>
            <div class="font-medium">${hasStream ? "Lecteur intégré" : "Via le site officiel"}</div>
          </div>
          ${hasStream ? `<div id="modal-status" class="text-xs px-3 py-1 rounded-full bg-white/5 text-white/60">Prêt</div>` : ""}
        </div>

        ${hasStream
          ? `
          <div id="modal-player">
            <div class="flex items-center justify-between text-xs mb-2 px-1">
              <span class="text-emerald-400 flex items-center gap-1">
                <span class="inline-block w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                Flux direct
              </span>
              <span class="text-white/40 text-[10px]">
                ${PROXY_BASE ? 'via proxy' : 'Suivi automatiquement'}
              </span>
            </div>

            <div class="flex items-center gap-2 mb-3">
              <button id="modal-play" class="player-button player-button--primary flex-1 text-base">▶ LIRE</button>
              <button id="modal-pause" class="player-button flex-1 hidden text-base">PAUSE</button>
              <button id="modal-seek-back" class="player-button w-14 text-sm">-15</button>
              <button id="modal-seek-fwd" class="player-button w-14 text-sm">+15</button>
            </div>

            <div id="modal-visualizer" class="visualizer mb-3 mx-auto w-full max-w-[260px]">
              ${Array.from({length: 9}).map(() => `<span class="bar"></span>`).join("")}
            </div>

            <div class="flex items-center gap-3 px-1">
              <span class="text-xs text-white/50 w-8">Vol</span>
              <input id="modal-volume" type="range" min="0" max="1" step="0.01" value="0.8" class="volume-slider flex-1">
              <span id="modal-vol-value" class="w-9 text-right text-xs text-white/60">80%</span>
            </div>
          </div>`
          : `
          <div class="text-center">
            <button onclick="window.open('${radio.website}', '_blank')" 
                    class="modal-btn w-full border border-accent/50 bg-accent/10 hover:bg-accent/20 py-3.5 font-semibold text-accentSoft">
              Ouvrir le lecteur officiel →
            </button>
            <p class="text-[10px] text-white/50 mt-2">Le flux de cette radio n'est pas disponible directement ici. Écoute via le site officiel.</p>
          </div>`
        }
      </div>

      <!-- Quick actions -->
      <div class="mt-4 flex gap-2">
        ${socials.join("")}
      </div>

      <!-- Schedule / Info -->
      <div class="mt-6 rounded-2xl border border-white/8 bg-white/[0.015] p-4 text-sm">
        <div class="font-medium mb-1 text-white/85">Horaire et émissions</div>
        <p class="text-white/60 text-[13px] leading-relaxed">
          Les grilles changent souvent. Consulte le site officiel de la radio pour la programmation complète et les balados.
        </p>
        <a href="${radio.website}" target="_blank" class="inline-block mt-2 text-xs text-accentSoft underline decoration-accent/30">Voir la programmation officielle →</a>
      </div>

      <div class="mt-4 flex justify-between items-center text-[10px] text-white/40 px-1">
        <div>${radio.region}</div>
        <button id="fav-btn" class="flex items-center gap-1 text-xs hover:text-white transition">
          <span id="fav-icon">♡</span>
          <span id="fav-text">Favori</span>
        </button>
      </div>
    </div>
  `;

  MODAL.classList.remove("hidden");
  MODAL.classList.add("flex");

  // Close button
  document.getElementById("modal-close").onclick = closeModal;

  // If has stream → wire player inside modal
  if (hasStream) {
    setupModalPlayer(radio);
  }

  // Favorites
  setupFavoritesButton(radio);

  // Keyboard escape already handled globally
}

function setupModalPlayer(radio) {
  const playBtn = document.getElementById("modal-play");
  const pauseBtn = document.getElementById("modal-pause");
  const backBtn = document.getElementById("modal-seek-back");
  const fwdBtn = document.getElementById("modal-seek-fwd");
  const volSlider = document.getElementById("modal-volume");
  const volValue = document.getElementById("modal-vol-value");
  const visual = document.getElementById("modal-visualizer");
  const status = document.getElementById("modal-status");

  if (!audio) setupAudio();

  // Restore volume
  const saved = localStorage.getItem("req-player-vol");
  const vol = saved ? parseFloat(saved) : 0.8;
  audio.volume = vol;
  if (volSlider) {
    volSlider.value = vol;
    volValue.textContent = Math.round(vol * 100) + "%";
  }

  const updateUI = () => {
    const playingThis = !audio.paused && currentRadio?.id === radio.id;
    if (playBtn && pauseBtn) {
      playBtn.classList.toggle("hidden", playingThis);
      pauseBtn.classList.toggle("hidden", !playingThis);
    }
    visual?.classList.toggle("is-playing", playingThis);
    if (status) status.textContent = playingThis ? "En direct" : "Prêt";
  };

  const playableUrl = getPlayableStream(radio);

  playBtn.onclick = async () => {
    try {
      if (audio.src !== playableUrl) {
        audio.src = playableUrl;
      }
      await audio.play();
      updateUI();
    } catch (err) {
      showToast("Appuie à nouveau pour autoriser la lecture.");
    }
  };

  pauseBtn.onclick = () => {
    audio.pause();
    updateUI();
  };

  backBtn.onclick = () => seek(-15);
  fwdBtn.onclick = () => seek(15);

  volSlider.oninput = (e) => {
    const v = parseFloat(e.target.value);
    audio.volume = v;
    localStorage.setItem("req-player-vol", v);
    volValue.textContent = Math.round(v * 100) + "%";
  };

  // Keep UI in sync — remove previous modal listeners before adding new ones
  audio._modalAbort?.abort();
  const ac = new AbortController();
  audio._modalAbort = ac;
  const { signal } = ac;
  audio.addEventListener("play", updateUI, { signal });
  audio.addEventListener("pause", updateUI, { signal });
  audio.addEventListener("ended", updateUI, { signal });

  // Initial state
  updateUI();
}

function setupFavoritesButton(radio) {
  const favBtn = document.getElementById("fav-btn");
  const favIcon = document.getElementById("fav-icon");
  const favText = document.getElementById("fav-text");

  const updateFavUI = () => {
    const favs = getFavorites();
    const isFav = favs.includes(radio.id);
    favIcon.textContent = isFav ? "♥" : "♡";
    favText.textContent = isFav ? "Retirer" : "Favori";
    favIcon.style.color = isFav ? "#f43f5e" : "";
  };

  favBtn.onclick = () => {
    toggleFavorite(radio.id);
    updateFavUI();
    // refresh grid so hearts appear if we ever show them on cards
    renderGrid();
  };

  updateFavUI();
}

function seek(seconds) {
  if (!audio || !audio.seekable || audio.seekable.length === 0) return;
  const idx = audio.seekable.length - 1;
  const target = Math.min(
    audio.seekable.end(idx),
    Math.max(audio.seekable.start(idx), audio.currentTime + seconds)
  );
  audio.currentTime = target;
}

function setupAudio() {
  if (audio) return;

  audio = new Audio();
  audio.preload = "none";
  // crossOrigin only needed when streams are served through our CORS proxy
  if (PROXY_BASE) audio.crossOrigin = "anonymous";

  audio.addEventListener("error", () => {
    showToast("Flux indisponible pour le moment.");
  });

  // Keep playing in background when possible (PWA)
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  }
}

async function playRadio(radio) {
  const playable = getPlayableStream(radio);
  if (!playable) {
    window.open(radio.website, "_blank");
    return;
  }

  if (!audio) setupAudio();

  try {
    if (audio.src !== playable) {
      audio.src = playable;
    }
    await audio.play();

    // update media session
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: radio.fullName,
        artist: radio.institution,
        album: "RÉQ — Radios Étudiantes QC",
      });
    }

    // If a modal is open for this radio, update its UI
    if (currentRadio?.id === radio.id) {
      const vis = document.getElementById("modal-visualizer");
      vis?.classList.add("is-playing");
      const st = document.getElementById("modal-status");
      if (st) st.textContent = "En direct";
    }

    showToast(`Lecture de ${radio.name}`);
  } catch (err) {
    showToast("Lecture bloquée. Appuie sur Play dans la carte ou le modal.");
  }
}

function closeModal() {
  MODAL.classList.remove("flex");
  MODAL.classList.add("hidden");
  currentRadio = null;

  // Pause only if you want. We keep audio playing for background listening.
  // Most users appreciate continuing playback.
}

function showToast(msg) {
  if (!TOAST_EL) return;
  TOAST_EL.textContent = msg;
  TOAST_EL.style.display = "block";
  TOAST_EL.classList.remove("hidden");

  setTimeout(() => {
    TOAST_EL.style.display = "none";
    TOAST_EL.classList.add("hidden");
  }, 2600);
}

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem("req-favorites") || "[]");
  } catch {
    return [];
  }
}

function toggleFavorite(id) {
  const favs = getFavorites();
  const idx = favs.indexOf(id);
  if (idx === -1) favs.push(id);
  else favs.splice(idx, 1);
  localStorage.setItem("req-favorites", JSON.stringify(favs));
}

// Install prompt (PWA)
function bindInstallFlow() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (INSTALL_BTN) {
      INSTALL_BTN.classList.remove("hidden");
      INSTALL_BTN.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        INSTALL_BTN.classList.add("hidden");
      };
    }
  });

  window.addEventListener("appinstalled", () => {
    if (INSTALL_BTN) INSTALL_BTN.classList.add("hidden");
    showToast("RÉQ installée. Merci !");
  });
}

// Helper to allow external calls if needed
window.REQ = { playRadio, openRadio: (id) => {
  const r = radios.find(x => x.id === id);
  if (r) openModal(r);
}};
