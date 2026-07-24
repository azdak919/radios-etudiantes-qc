/**
 * Le Radar — diffusion distante (AirPlay WebKit + Chromecast).
 *
 * Chrome / Edge / Android Chrome : Cast SDK (CAF).
 * Safari / iOS : AirPlay via webkitShowPlaybackTargetPicker.
 * Firefox : bouton visible mais grisé (pas d'API Cast).
 *
 * Correctifs majeurs :
 *  - bouton visible dès que le framework est prêt (pas seulement si des
 *    appareils ont déjà été découverts — NO_DEVICES est souvent temporaire)
 *  - SESSION_STARTING / STARTED / RESUMED / ENDED gérés proprement
 *  - pause / reprise distante sans forcément tuer la session
 *  - rechargement du média au changement de poste
 *  - restauration locale si loadMedia échoue
 */
(function () {
  'use strict';

  let deps = null;
  let castBtns = [];
  let airPlayAvailable = false;
  let castFrameworkReady = false;
  let chromecastSessionActive = false;
  let castMediaLoaded = false;
  let castRemotePaused = false;
  let localWasPlaying = false;
  let sdkInjected = false;
  let discoveryTimer = null;

  const ua = navigator.userAgent || '';
  const isFirefox = /Firefox/i.test(ua);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua)
    || (/iPad|iPhone|iPod/.test(ua) && !window.MSStream);
  // Chromium (desktop + Android Chrome / Edge) — pas Safari pur.
  const isChromium = !isFirefox && !isSafari
    && (/Chrome|Chromium|CriOS|Edg|EdgiOS|OPR\//i.test(ua) || !!window.chrome);

  if (isFirefox) document.documentElement.classList.add('is-firefox');

  function guessContentType(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
    if (/\.aac(\?|$)/i.test(url)) return 'audio/aac';
    if (/\.ogg(\?|$)/i.test(url)) return 'audio/ogg';
    if (/\.mp3(\?|$)/i.test(url)) return 'audio/mpeg';
    return 'audio/mpeg';
  }

  function stationMetadata(radio) {
    const extra = deps.getNowAirMeta?.(radio) || {};
    const built = deps.buildMediaSessionMeta?.(radio, extra);
    if (built) {
      return {
        title: built.title,
        artist: built.artist,
        subtitle: built.album || '',
      };
    }
    return {
      title: radio.fullName || radio.name,
      artist: deps.formatInstitution?.(radio.institution) || radio.institution || 'Le Radar',
      subtitle: '',
    };
  }

  /** L'API du sélecteur AirPlay système est présente sur ce lecteur. */
  function airPlayCapable() {
    const player = deps?.getPlayer?.();
    return !!(player && typeof player.webkitShowPlaybackTargetPicker === 'function');
  }

  /** Bouton affiché : framework prêt, AirPlay, ou Chromium en attente du SDK. */
  function isAvailable() {
    if (airPlayAvailable) return true;
    // Safari / iOS : le picker AirPlay système est toujours invocable, même si
    // l'événement de disponibilité n'a pas encore été reçu (il ne part souvent
    // qu'une fois un src chargé — trop tard pour montrer le bouton).
    if (isSafari && airPlayCapable()) return true;
    if (castFrameworkReady) return true;
    // Pendant le chargement du SDK, montrer le bouton (désactivé) sur Chromium.
    if (isChromium && sdkInjected) return true;
    return false;
  }

  function isCasting() {
    const player = deps?.getPlayer?.();
    return chromecastSessionActive || !!player?.webkitCurrentPlaybackTargetIsWireless;
  }

  function isChromecasting() {
    return chromecastSessionActive;
  }

  /** Session Cast active et média en lecture (pas en pause distante). */
  function isRemotePlaying() {
    return chromecastSessionActive && castMediaLoaded && !castRemotePaused;
  }

  function notifyCastStateChange() {
    deps?.onCastStateChange?.();
  }

  function updateButton() {
    if (!castBtns.length) return;
    const station = deps?.getStation?.();
    const hasStream = !!(station && deps.getStreamUrl?.(station) && !deps.isExternal?.(station));
    const available = isAvailable();
    const showOnFirefox = isFirefox;
    const show = available || showOnFirefox;
    const unavailable = isFirefox || (isChromium && !castFrameworkReady && !airPlayAvailable);
    const canClick = hasStream && !unavailable
      && (airPlayAvailable || castFrameworkReady || (isSafari && airPlayCapable()));
    const casting = isCasting();

    let title;
    let ariaLabel;
    if (isFirefox) {
      title = 'Diffusion non disponible dans Firefox — utilisez Chrome ou Edge';
      ariaLabel = title;
    } else if (unavailable) {
      title = 'Connexion au service Cast…';
      ariaLabel = title;
    } else if (casting) {
      title = 'Arrêter la diffusion externe';
      ariaLabel = title;
    } else {
      title = 'Diffuser sur un appareil (Chromecast ou AirPlay)';
      ariaLabel = 'Diffuser sur un appareil';
    }

    castBtns.forEach((btn) => {
      // Visibilité : retirer hidden HTML + classe .hidden ensemble.
      const hide = !show;
      btn.hidden = hide;
      btn.classList.toggle('hidden', hide);
      btn.classList.toggle('is-unavailable', unavailable);
      btn.classList.toggle('is-casting', casting && !unavailable);
      btn.disabled = !canClick;
      btn.setAttribute('aria-disabled', String(!canClick));
      btn.setAttribute('aria-pressed', casting && !unavailable ? 'true' : 'false');
      btn.title = title;
      btn.setAttribute('aria-label', ariaLabel);
    });
  }

  function setupAirPlay(player) {
    if (!player || player.__radarAirPlayBound) return;
    player.__radarAirPlayBound = true;
    try { player.setAttribute('x-webkit-airplay', 'allow'); } catch {}

    player.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      airPlayAvailable = e.availability === 'available';
      updateButton();
    });
    player.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      updateButton();
      notifyCastStateChange();
    });
    if (typeof player.webkitSetPresentationMode === 'function') {
      player.addEventListener('webkitpresentationmodechanged', () => updateButton());
    }
    try {
      if (player.webkitPlaybackTargetAvailability === 'available') {
        airPlayAvailable = true;
      }
    } catch {}
  }

  function getCastSession() {
    try {
      if (!castFrameworkReady || !window.cast?.framework) return null;
      return cast.framework.CastContext.getInstance().getCurrentSession() || null;
    } catch {
      return null;
    }
  }

  function getRemoteMedia() {
    try {
      return getCastSession()?.getMediaSession() || null;
    } catch {
      return null;
    }
  }

  function buildMediaInfo(url, radio) {
    const { title, artist, subtitle } = stationMetadata(radio);
    const mediaInfo = new chrome.cast.media.MediaInfo(url, guessContentType(url));
    mediaInfo.streamType = chrome.cast.media.StreamType.LIVE;
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.metadataType = chrome.cast.media.MetadataType.GENERIC;
    mediaInfo.metadata.title = title;
    mediaInfo.metadata.subtitle = subtitle || artist || '';
    // GenericMediaMetadata utilise .images ; certains appareils lisent aussi artist.
    try { mediaInfo.metadata.artist = artist; } catch {}
    try {
      const icon = deps.assetUrl?.('assets/icon-512.png');
      if (icon) mediaInfo.metadata.images = [new chrome.cast.Image(icon)];
    } catch {}
    return mediaInfo;
  }

  function loadCastMedia() {
    const station = deps.getStation?.();
    const url = station && deps.getStreamUrl?.(station);
    const session = getCastSession();
    if (!url || !session || !window.chrome?.cast?.media) return;

    castMediaLoaded = false;
    castRemotePaused = false;

    const request = new chrome.cast.media.LoadRequest(buildMediaInfo(url, station));
    request.autoplay = true;

    session.loadMedia(request).then(
      () => {
        castMediaLoaded = true;
        castRemotePaused = false;
        chromecastSessionActive = true;
        // Couper le local une fois le distant confirmé.
        deps.pauseLocal?.();
        updateButton();
        notifyCastStateChange();
      },
      (err) => {
        console.warn('Cast loadMedia failed', err);
        castMediaLoaded = false;
        deps.showToast?.('Impossible de diffuser ce flux. Réessaie ou choisis un autre poste.');
        // Laisser la session ouverte : l'utilisateur peut changer de poste.
        // Si le local jouait avant, le relancer.
        if (localWasPlaying && !deps.isUserPaused?.()) {
          const s = deps.getStation?.();
          if (s) deps.playStation?.(s);
        }
        updateButton();
        notifyCastStateChange();
      },
    );
  }

  function pauseRemoteMedia() {
    const media = getRemoteMedia();
    if (!media) {
      endChromecastSession(false);
      return;
    }
    try {
      media.pause(new chrome.cast.media.PauseRequest(), () => {
        castRemotePaused = true;
        notifyCastStateChange();
      }, () => {
        // Pause non supportée (souvent LIVE) → arrêter la session.
        endChromecastSession(false);
      });
    } catch {
      endChromecastSession(false);
    }
  }

  function resumeRemoteMedia() {
    const media = getRemoteMedia();
    if (!media) {
      loadCastMedia();
      return;
    }
    try {
      media.play(new chrome.cast.media.PlayRequest(), () => {
        castRemotePaused = false;
        deps.pauseLocal?.();
        notifyCastStateChange();
      }, () => {
        loadCastMedia();
      });
    } catch {
      loadCastMedia();
    }
  }

  function onCastStateChanged() {
    if (!castFrameworkReady) return;
    try {
      // On n'utilise plus NO_DEVICES pour cacher le bouton : la découverte est
      // asynchrone et requestSession() relance une recherche.
      updateButton();
    } catch {}
  }

  function onSessionStateChanged(ev) {
    const st = ev.sessionState;
    const S = cast.framework.SessionState;

    if (st === S.SESSION_STARTING) {
      chromecastSessionActive = true;
      castMediaLoaded = false;
      castRemotePaused = false;
      localWasPlaying = !!deps.isPlaying?.();
      deps.pauseLocal?.();
      updateButton();
      notifyCastStateChange();
      return;
    }

    if (st === S.SESSION_STARTED || st === S.SESSION_RESUMED) {
      chromecastSessionActive = true;
      if (st === S.SESSION_STARTED) {
        localWasPlaying = localWasPlaying || !!deps.isPlaying?.();
        deps.pauseLocal?.();
      }
      loadCastMedia();
      updateButton();
      notifyCastStateChange();
      return;
    }

    if (st === S.SESSION_ENDING) {
      // garder l'état jusqu'à ENDED pour éviter un flash UI
      return;
    }

    if (st === S.SESSION_ENDED) {
      chromecastSessionActive = false;
      castMediaLoaded = false;
      castRemotePaused = false;
      updateButton();
      notifyCastStateChange();
      if (localWasPlaying && !deps.isUserPaused?.()) {
        const s = deps.getStation?.();
        if (s) deps.playStation?.(s);
      }
      localWasPlaying = false;
    }
  }

  function initCastFramework() {
    if (castFrameworkReady) {
      updateButton();
      return;
    }
    if (!window.cast?.framework || !window.chrome?.cast) {
      return;
    }

    try {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        resumeSavedSession: true,
        androidReceiverCompatible: true,
      });

      ctx.addEventListener(
        cast.framework.CastContextEventType.CAST_STATE_CHANGED,
        onCastStateChanged,
      );
      ctx.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        onSessionStateChanged,
      );

      castFrameworkReady = true;

      // Session déjà ouverte (retour d'onglet / resume).
      const existing = ctx.getCurrentSession();
      if (existing) {
        chromecastSessionActive = true;
        loadCastMedia();
      }

      updateButton();
      notifyCastStateChange();

      // Re-vérifier périodiquement un court moment (découverte mDNS lente).
      if (discoveryTimer) clearInterval(discoveryTimer);
      let ticks = 0;
      discoveryTimer = setInterval(() => {
        ticks += 1;
        updateButton();
        if (ticks >= 12 || !castFrameworkReady) {
          clearInterval(discoveryTimer);
          discoveryTimer = null;
        }
      }, 2500);
    } catch (e) {
      console.warn('Cast framework init failed', e);
      castFrameworkReady = false;
      updateButton();
    }
  }

  // Callback global Cast SDK — doit exister avant le chargement du script.
  const prevCastCb = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = function (isAvailable, err) {
    try { prevCastCb?.(isAvailable, err); } catch {}
    if (isAvailable) initCastFramework();
    else {
      console.warn('Cast API unavailable', err);
      updateButton();
    }
  };

  function loadCastSdk() {
    if (isFirefox || isSafari) return;
    if (sdkInjected) {
      // SDK déjà là (navigation BFCache / second init).
      if (window.cast?.framework) initCastFramework();
      return;
    }
    sdkInjected = true;

    // Si le framework est déjà injecté par une extension / cache.
    if (window.cast?.framework) {
      initCastFramework();
      return;
    }

    const existing = document.querySelector('script[data-radar-cast]');
    if (existing) {
      // Attendre le callback ; filet de secours.
      setTimeout(() => {
        if (!castFrameworkReady && window.cast?.framework) initCastFramework();
        updateButton();
      }, 1500);
      return;
    }

    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.async = true;
    s.dataset.radarCast = '1';
    s.onerror = () => {
      console.warn('Cast SDK failed to load');
      sdkInjected = false;
      updateButton();
    };
    document.head.appendChild(s);

    // Filet si le callback ne part pas (extensions, cache partiel).
    setTimeout(() => {
      if (!castFrameworkReady && window.cast?.framework) initCastFramework();
      updateButton();
    }, 2500);
    setTimeout(() => {
      if (!castFrameworkReady && window.cast?.framework) initCastFramework();
      updateButton();
    }, 8000);

    updateButton();
  }

  function endChromecastSession(stopCasting = true) {
    if (!chromecastSessionActive && !getCastSession()) {
      chromecastSessionActive = false;
      castMediaLoaded = false;
      castRemotePaused = false;
      updateButton();
      notifyCastStateChange();
      return;
    }
    try {
      if (castFrameworkReady) {
        cast.framework.CastContext.getInstance().endCurrentSession(!!stopCasting);
      }
    } catch {}
    chromecastSessionActive = false;
    castMediaLoaded = false;
    castRemotePaused = false;
    updateButton();
    notifyCastStateChange();
  }

  async function showPicker() {
    const station = deps.getStation?.();
    if (!station || deps.isExternal?.(station) || !deps.getStreamUrl?.(station)) {
      deps.showToast?.('Choisis d’abord un poste à diffuser.');
      return;
    }

    // Second clic : arrêter la diffusion.
    if (chromecastSessionActive) {
      localWasPlaying = false;
      endChromecastSession(true);
      return;
    }

    const player = deps.getPlayer?.();

    // AirPlay prioritaire seulement sur Safari (ou si Cast indisponible).
    // Sur Safari, ne pas exiger l'événement de disponibilité : le picker
    // système gère lui-même le cas « aucun appareil ».
    const canAirPlay = !!player?.webkitShowPlaybackTargetPicker
      && (airPlayAvailable || isSafari);
    const preferAirPlay = canAirPlay && (isSafari || !castFrameworkReady);

    if (preferAirPlay) {
      if (!deps.isPlaying?.()) {
        try { await deps.playStation?.(station); } catch {}
      }
      try {
        player.webkitShowPlaybackTargetPicker();
      } catch (e) {
        console.warn('AirPlay picker failed', e);
        deps.showToast?.('AirPlay indisponible pour le moment.');
      }
      return;
    }

    if (castFrameworkReady) {
      // Démarrer la lecture locale d'abord (geste utilisateur) puis basculer.
      localWasPlaying = true;
      if (!deps.isPlaying?.()) {
        try { await deps.playStation?.(station); } catch {}
      }
      try {
        await cast.framework.CastContext.getInstance().requestSession();
        // SESSION_* handlers s'occupent de loadMedia + pause locale.
      } catch (e) {
        const code = e?.code || e;
        const cancelled = code === 'cancel'
          || code === chrome?.cast?.ErrorCode?.CANCEL
          || String(e).toLowerCase().includes('cancel');
        if (!cancelled) {
          console.warn('Cast requestSession failed', e);
          deps.showToast?.('Aucun appareil Cast trouvé. Vérifie le Wi‑Fi.');
          if (canAirPlay) {
            try { player.webkitShowPlaybackTargetPicker(); } catch {}
          }
        }
      }
      return;
    }

    if (canAirPlay) {
      try {
        if (!deps.isPlaying?.()) await deps.playStation?.(station);
        player.webkitShowPlaybackTargetPicker();
      } catch {}
      return;
    }

    if (isChromium && sdkInjected) {
      deps.showToast?.('Cast se charge… réessaie dans une seconde.');
      loadCastSdk();
      return;
    }

    deps.showToast?.('Diffusion non disponible sur ce navigateur.');
  }

  function init(options) {
    deps = options;
    castBtns = ['tuner-cast', 'tuner-cast-mob', 'tuner-cast-pop']
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    const player = deps.getPlayer?.() || document.getElementById('radar-player');
    if (!castBtns.length) return;

    setupAirPlay(player);
    loadCastSdk();

    castBtns.forEach((btn) => {
      if (btn.__radarCastBound) return;
      btn.__radarCastBound = true;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showPicker();
      });
    });

    updateButton();
  }

  window.RadarCast = {
    init,
    /** À rappeler quand l'élément <audio> est recréé (rebuildAudio). */
    attachPlayer(el) {
      setupAirPlay(el);
      updateButton();
    },
    onStationChange() {
      if (chromecastSessionActive) loadCastMedia();
      updateButton();
    },
    updateButton,
    isAvailable,
    endSession: () => endChromecastSession(true),
    /** Pause distante (ou fin de session si pause LIVE impossible). */
    pauseRemote() {
      if (chromecastSessionActive) {
        pauseRemoteMedia();
        return;
      }
      const player = deps?.getPlayer?.();
      if (player && !player.paused) {
        try { player.pause(); } catch {}
      }
    },
    /** Reprend le média Cast si session active. */
    resumeRemote() {
      if (chromecastSessionActive) {
        resumeRemoteMedia();
        return true;
      }
      return false;
    },
    isCasting,
    isChromecasting,
    isRemotePlaying,
  };
})();
