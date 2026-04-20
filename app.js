import { fetchJsonWithFallbacks, cleanText } from "./data-utils.js";
import { initSchedulePanel } from "./schedule.js";
import { initNewsFeed } from "./news.js";

const STREAM_URL = "https://ecoutez.chyz.ca/proxy/chyz943/stream";
const STREAM_STATUS_URL = "http://ecoutez.chyz.ca:8000/status-json.xsl";
const PLAYER_STORAGE_KEY = "chyz-plus-player";
const LAST_META_KEY = "chyz-plus-last-meta";

const defaultTrack = {
  title: "CHYZ 94.3 FM en direct",
  subtitle: "Compagnon non officiel de la radio etudiante de l'Universite Laval.",
};

const audio = document.querySelector("#radio-audio");
const playButton = document.querySelector("#play-button");
const playButtonIcon = document.querySelector("#play-button-icon");
const playButtonLabel = document.querySelector("#play-button-label");
const muteButton = document.querySelector("#mute-button");
const muteButtonIcon = document.querySelector("#mute-button-icon");
const backwardButton = document.querySelector("#backward-button");
const forwardButton = document.querySelector("#forward-button");
const volumeSlider = document.querySelector("#volume-slider");
const volumeReadout = document.querySelector("#volume-readout");
const nowPlayingTitle = document.querySelector("#now-playing-title");
const nowPlayingSubtitle = document.querySelector("#now-playing-subtitle");
const playerStatePill = document.querySelector("#player-state-pill");
const visualizer = document.querySelector("#visualizer");
const installButton = document.querySelector("#install-button");
const installHint = document.querySelector("#install-hint");
const toast = document.querySelector("#toast");

let deferredInstallPrompt = null;
let toastTimer = null;
let metaIntervalId = null;

boot();

function boot() {
  restorePlayerState();
  audio.src = STREAM_URL;
  audio.volume = clampVolume(audio.volume);
  audio.preload = "none";

  bindPlayerEvents();
  bindInstallFlow();
  registerServiceWorker();
  updateTrack(defaultTrack);
  updatePlayerUI();
  setVolumeLabel();
  setStreamLabel();
  applyMediaSession(defaultTrack);

  initSchedulePanel();
  initNewsFeed();
}

function bindPlayerEvents() {
  playButton.addEventListener("click", togglePlayback);
  muteButton.addEventListener("click", toggleMute);
  backwardButton.addEventListener("click", () => seekBy(-15));
  forwardButton.addEventListener("click", () => seekBy(15));
  volumeSlider.addEventListener("input", handleVolumeInput);

  audio.addEventListener("play", () => {
    visualizer.classList.add("is-playing");
    playerStatePill.textContent = "Lecture";
    updatePlayerUI();
    startMetadataRefresh();
  });

  audio.addEventListener("pause", () => {
    visualizer.classList.remove("is-playing");
    playerStatePill.textContent = "Pause";
    updatePlayerUI();
    stopMetadataRefresh();
  });

  audio.addEventListener("playing", () => {
    playerStatePill.textContent = "En direct";
    fetchNowPlaying();
  });

  audio.addEventListener("waiting", () => {
    playerStatePill.textContent = "Mise en memoire tampon";
  });

  audio.addEventListener("stalled", () => {
    playerStatePill.textContent = "Connexion instable";
  });

  audio.addEventListener("error", () => {
    playerStatePill.textContent = "Flux indisponible";
    showToast(
      "Le flux CHYZ n'a pas repondu. Sur un site HTTPS, un relais securise peut etre necessaire."
    );
  });

  audio.addEventListener("volumechange", () => {
    setVolumeLabel();
    updateMuteUI();
    persistPlayerState();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchNowPlaying();
    }
  });
}

async function togglePlayback() {
  try {
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  } catch (error) {
    console.error(error);
    playerStatePill.textContent = "Lecture bloquee";
    showToast("Appuie a nouveau pour autoriser la lecture audio sur ce navigateur.");
  }
}

function toggleMute() {
  audio.muted = !audio.muted;
  updateMuteUI();
}

function handleVolumeInput(event) {
  const value = clampVolume(Number(event.target.value));
  audio.muted = false;
  audio.volume = value;
  persistPlayerState();
}

function updatePlayerUI() {
  const isPlaying = !audio.paused;
  playButton.setAttribute("aria-pressed", String(isPlaying));
  playButtonIcon.textContent = isPlaying ? "❚❚" : "▶";
  playButtonLabel.textContent = isPlaying ? "Pause" : "Lire";
}

function updateMuteUI() {
  const muted = audio.muted || audio.volume === 0;
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButtonIcon.textContent = muted ? "🔇" : "🔊";
}

function setVolumeLabel() {
  const currentVolume = audio.muted ? 0 : audio.volume;
  volumeSlider.value = String(audio.muted ? audio.volume : currentVolume);
  volumeReadout.textContent = `${Math.round(currentVolume * 100)}%`;
}

function seekBy(seconds) {
  if (!audio.seekable || audio.seekable.length === 0 || !Number.isFinite(audio.currentTime)) {
    showToast("Ce direct ne permet pas encore le saut dans le tampon.");
    return;
  }

  const seekableIndex = audio.seekable.length - 1;
  const min = audio.seekable.start(seekableIndex);
  const max = audio.seekable.end(seekableIndex);
  const target = Math.min(max, Math.max(min, audio.currentTime + seconds));

  audio.currentTime = target;

  if (seconds > 0 && target >= max - 0.25) {
    playerStatePill.textContent = "Retour au direct";
  }
}

function persistPlayerState() {
  localStorage.setItem(
    PLAYER_STORAGE_KEY,
    JSON.stringify({
      volume: audio.volume,
      muted: audio.muted,
    })
  );
}

function restorePlayerState() {
  const savedState = localStorage.getItem(PLAYER_STORAGE_KEY);

  if (savedState) {
    try {
      const parsed = JSON.parse(savedState);
      audio.volume = clampVolume(parsed.volume ?? 0.8);
      audio.muted = Boolean(parsed.muted);
    } catch (error) {
      console.warn("Unable to restore saved player state.", error);
    }
  } else {
    audio.volume = 0.8;
  }

  const lastTrack = localStorage.getItem(LAST_META_KEY);
  if (lastTrack) {
    try {
      const parsedTrack = JSON.parse(lastTrack);
      updateTrack(parsedTrack);
    } catch (error) {
      console.warn("Unable to restore last track.", error);
    }
  }
}

async function fetchNowPlaying() {
  try {
    const data = await fetchJsonWithFallbacks(STREAM_STATUS_URL);
    const source = Array.isArray(data?.icestats?.source)
      ? data.icestats.source[0]
      : data?.icestats?.source;

    const candidateTitle =
      source?.title ||
      source?.server_name ||
      source?.server_description ||
      defaultTrack.title;

    const subtitleParts = [source?.server_description, source?.genre]
      .filter(Boolean)
      .slice(0, 2);

    updateTrack({
      title: cleanText(candidateTitle),
      subtitle:
        subtitleParts.length > 0
          ? cleanText(subtitleParts.join(" • "))
          : defaultTrack.subtitle,
    });
  } catch (error) {
    updateTrack(defaultTrack, { persist: false });
    console.warn("Now playing metadata unavailable.", error);
  }
}

function updateTrack(track, options = { persist: true }) {
  const safeTrack = {
    title: cleanText(track?.title) || defaultTrack.title,
    subtitle: cleanText(track?.subtitle) || defaultTrack.subtitle,
  };

  nowPlayingTitle.textContent = safeTrack.title;
  nowPlayingSubtitle.textContent = safeTrack.subtitle;
  applyMediaSession(safeTrack);

  if (options.persist !== false) {
    localStorage.setItem(LAST_META_KEY, JSON.stringify(safeTrack));
  }
}

function applyMediaSession(track) {
  if (!("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: "CHYZ 94.3 FM",
    album: "Universite Laval",
    artwork: [
      { src: "assets/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "assets/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });

  navigator.mediaSession.setActionHandler("play", () => togglePlayback());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("stop", () => audio.pause());
  navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
  navigator.mediaSession.setActionHandler("seekforward", () => seekBy(15));
}

function startMetadataRefresh() {
  if (metaIntervalId) {
    return;
  }

  fetchNowPlaying();
  metaIntervalId = window.setInterval(fetchNowPlaying, 45_000);
}

function stopMetadataRefresh() {
  if (!metaIntervalId) {
    return;
  }

  window.clearInterval(metaIntervalId);
  metaIntervalId = null;
}

function bindInstallFlow() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.classList.remove("hidden");
    installHint.textContent = "Installe CHYZ+ pour lancer le direct depuis l'ecran d'accueil.";
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast("Ajoute l'app a l'ecran d'accueil depuis le menu de ton navigateur.");
      return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    installButton.classList.add("hidden");
    installHint.textContent = "CHYZ+ est installee sur cet appareil.";
  });

  if (isIosStandaloneCapable()) {
    installHint.textContent =
      "Sur iPhone ou iPad: partage puis Sur l'ecran d'accueil pour installer.";
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service worker registration failed.", error);
  }
}

function setStreamLabel() {
  const streamUrlLabel = document.querySelector("#stream-url-label");
  if (streamUrlLabel) {
    streamUrlLabel.textContent = STREAM_URL;
  }
}

function showToast(message) {
  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.classList.remove("translate-y-8", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.add("translate-y-8", "opacity-0");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 3200);
}

function isIosStandaloneCapable() {
  const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  return ios && !window.matchMedia("(display-mode: standalone)").matches;
}

function clampVolume(value) {
  if (!Number.isFinite(value)) {
    return 0.8;
  }

  return Math.min(1, Math.max(0, value));
}
