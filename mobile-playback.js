/**
 * LE RADAR — contrôleur de lecture mobile en arrière-plan.
 *
 * Stratégie hybride (stream distant via <audio>, pas audio local comme Ataraxia) :
 *   1. Boucle WAV silencieuse (MediaElement) — keepalive principal iOS + Android
 *   2. Oscillateur ultrasonique Web Audio — complément Android uniquement
 *   3. Watchdog 2,5 s quand l'écran est verrouillé
 *   4. Reconnexion résiliente avec backoff exponentiel borné
 */
(function (global) {
  'use strict';

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_MOBILE = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const DEFAULT_CONFIG = Object.freeze({
    watchIntervalMs: 2500,
    stallDelayBgMs: 1200,
    stallDelayFgMs: 4000,
    resumeInitialMs: 150,
    resumeBackoffBaseMs: 180,
    resumeBackoffFactor: 1.55,
    resumeBackoffMaxMs: 4000,
    reconnectMaxFg: 4,
    reconnectMaxBg: 8,
    reconnectMinGapMs: 2000,
    keepaliveWavSec: 2,
    keepaliveFreqHz: 19500,
    keepaliveGain: 0.001,
  });

  function encodeSilentWav(seconds, freq, gain, sampleRate = 44100) {
    const n = sampleRate * seconds;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = Math.sin(2 * Math.PI * freq * i / sampleRate) * gain;
    }
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let j = 0; j < s.length; j++) v.setUint8(o + j, s.charCodeAt(j)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function createMobilePlayback(deps, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    let keepaliveCtx = null;
    let keepaliveOsc = null;
    let keepaliveGain = null;
    let keepaliveAudio = null;
    let keepaliveBlobUrl = null;

    let watchTimer = null;
    let resumeTimer = null;
    let stallTimer = null;
    let resumeAttempt = 0;
    let reconnectTries = 0;
    let lastReconnectAt = 0;

    function isBackground() {
      return IS_MOBILE && document.visibilityState === 'hidden';
    }

    function isStationResilient() {
      return !!deps.isStationResilient?.();
    }

    function shouldRecover() {
      return isStationResilient() || isBackground();
    }

    function maxReconnectTries() {
      return isBackground() ? cfg.reconnectMaxBg : cfg.reconnectMaxFg;
    }

    function setPlaybackSession() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {}
    }

    function releasePlaybackSession() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'auto';
      } catch {}
    }

    function stopOscillator() {
      if (keepaliveOsc) {
        try { keepaliveOsc.stop(); } catch {}
        keepaliveOsc = null;
      }
      if (keepaliveGain) {
        try { keepaliveGain.disconnect(); } catch {}
        keepaliveGain = null;
      }
    }

    function startWavKeepalive() {
      if (!keepaliveBlobUrl) {
        keepaliveBlobUrl = URL.createObjectURL(
          encodeSilentWav(cfg.keepaliveWavSec, cfg.keepaliveFreqHz, cfg.keepaliveGain),
        );
      }
      if (!keepaliveAudio) {
        keepaliveAudio = new Audio(keepaliveBlobUrl);
        keepaliveAudio.id = 'radar-keepalive';
        keepaliveAudio.loop = true;
        keepaliveAudio.volume = 1;
        keepaliveAudio.setAttribute('playsinline', '');
      }
      if (keepaliveAudio.paused) keepaliveAudio.play().catch(() => {});
    }

    function startAndroidOscillator() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!keepaliveOsc) {
        keepaliveCtx = keepaliveCtx || new Ctx();
        if (keepaliveCtx.state === 'suspended') keepaliveCtx.resume().catch(() => {});
        keepaliveGain = keepaliveCtx.createGain();
        keepaliveGain.gain.value = cfg.keepaliveGain;
        keepaliveGain.connect(keepaliveCtx.destination);
        keepaliveOsc = keepaliveCtx.createOscillator();
        keepaliveOsc.type = 'sine';
        keepaliveOsc.frequency.value = cfg.keepaliveFreqHz;
        keepaliveOsc.connect(keepaliveGain);
        keepaliveOsc.start();
        keepaliveCtx.onstatechange = () => {
          if (keepaliveCtx?.state === 'suspended' && deps.isPlaying() && !deps.isUserPaused()) {
            keepaliveCtx.resume().catch(() => {});
          }
        };
      } else if (keepaliveCtx?.state === 'suspended') {
        keepaliveCtx.resume().catch(() => {});
      }
    }

    function startKeepalive() {
      if (!IS_MOBILE || !deps.isPlaying() || deps.isUserPaused()) return;
      setPlaybackSession();
      try { startWavKeepalive(); } catch {}
      if (IS_IOS) {
        stopOscillator();
        if (keepaliveCtx) {
          try { keepaliveCtx.close(); } catch {}
          keepaliveCtx = null;
        }
        return;
      }
      try { startAndroidOscillator(); } catch {}
    }

    function stopKeepalive() {
      releasePlaybackSession();
      stopOscillator();
      if (keepaliveAudio) {
        try { keepaliveAudio.pause(); } catch {}
      }
      if (keepaliveCtx) {
        try { keepaliveCtx.close(); } catch {}
        keepaliveCtx = null;
      }
    }

    function clearResumeTimer() {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    }

    function clearStallTimer() {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    }

    function clearWatch() {
      if (watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
    }

    function resumeBackoffMs() {
      return Math.min(
        cfg.resumeBackoffMaxMs,
        Math.round(cfg.resumeBackoffBaseMs * Math.pow(cfg.resumeBackoffFactor, resumeAttempt)),
      );
    }

    function canReconnectNow() {
      return Date.now() - lastReconnectAt >= cfg.reconnectMinGapMs;
    }

    function tryResumePlayback() {
      if (deps.isUserPaused() || !deps.getStation() || deps.isExternalListen?.()) return;

      deps.ensureNativePlayback?.();
      if (keepaliveCtx?.state === 'suspended') keepaliveCtx.resume().catch(() => {});
      deps.resumeAudioCtx?.();

      const player = deps.getPlayer();
      if (!player) return;

      if (!player.paused && player.src && player.readyState < 2 && isBackground()) {
        if (shouldRecover() && canReconnectNow()) deps.performReconnect?.();
        return;
      }

      if (player.paused && player.src) {
        deps.syncMediaSession?.();
        player.play().catch(() => deps.playStation?.(deps.getStation()));
      } else if (!deps.isPlaying()) {
        deps.playStation?.(deps.getStation());
      } else {
        deps.syncMediaSession?.();
      }

      if (deps.isPlaying()) startKeepalive();
    }

    function scheduleResume(delay = cfg.resumeInitialMs) {
      if (deps.isUserPaused() || !deps.getStation() || deps.isExternalListen?.()) return;
      clearResumeTimer();
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        tryResumePlayback();
        if (isBackground() && !deps.isUserPaused() && !deps.isPlaying()) {
          resumeAttempt += 1;
          scheduleResume(resumeBackoffMs());
        } else {
          resumeAttempt = 0;
        }
      }, delay);
    }

    function startWatch() {
      if (deps.isUserPaused() || !deps.getStation() || deps.isExternalListen?.()) return;
      clearWatch();
      watchTimer = setInterval(tryResumePlayback, cfg.watchIntervalMs);
    }

    function onBackgroundEnter() {
      if (!deps.isPlaying() || deps.isUserPaused()) return;
      startKeepalive();
      deps.syncMediaSession?.();
      startWatch();
    }

    function onBackgroundExit() {
      clearWatch();
      clearResumeTimer();
      resumeAttempt = 0;
      tryResumePlayback();
    }

    function setupLifecycle() {
      if (!IS_MOBILE) return;

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onBackgroundEnter();
        else onBackgroundExit();
      });

      window.addEventListener('pagehide', () => {
        if (!deps.isUserPaused() && deps.isPlaying()) startWatch();
      });

      window.addEventListener('pageshow', (e) => {
        if (e.persisted) tryResumePlayback();
      });

      document.addEventListener('freeze', () => {
        if (!deps.isUserPaused() && deps.isPlaying()) deps.syncMediaSession?.();
      });

      document.addEventListener('resume', () => {
        clearWatch();
        tryResumePlayback();
      });
    }

    function attachToPlayer(el) {
      if (!IS_MOBILE || !el || el.__radarMobilePlayback) return;
      el.__radarMobilePlayback = true;

      const onBgSignal = () => {
        if (!deps.isUserPaused() && deps.getStation() && isBackground()) {
          scheduleResume(cfg.resumeInitialMs);
        }
      };

      el.addEventListener('pause', onBgSignal);
      el.addEventListener('suspend', () => onBgSignal());
      el.addEventListener('emptied', () => onBgSignal());
      el.addEventListener('stalled', () => onStall());
      el.addEventListener('waiting', () => onStall());
    }

    function onStall() {
      // En premier plan, laisser le navigateur tamponner (reconnecter sur « waiting »
      // provoquait des boucles de buffering, surtout sur CFAK / Radiomast).
      if (!isBackground() || stallTimer) return;
      const delay = cfg.stallDelayBgMs;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        const player = deps.getPlayer();
        if (!player || player.paused) return;
        if (player.readyState >= 3) return;
        if (canReconnectNow()) deps.performReconnect?.();
      }, delay);
    }

    function onPlaying() {
      reconnectTries = 0;
      resumeAttempt = 0;
      clearStallTimer();
      startKeepalive();
      deps.syncMediaSession?.();
    }

    function onPlayStart() {
      reconnectTries = 0;
      resumeAttempt = 0;
      startKeepalive();
    }

    function onPlayStop() {
      clearWatch();
      clearResumeTimer();
      clearStallTimer();
      reconnectTries = 0;
      resumeAttempt = 0;
      stopKeepalive();
    }

    function onUserPause() {
      onPlayStop();
    }

    function shouldHandleEnded() {
      return shouldRecover() && reconnectTries < maxReconnectTries();
    }

    function shouldHandleError(currentTime) {
      return shouldRecover() && currentTime > 0 && reconnectTries < maxReconnectTries();
    }

    function attemptReconnect() {
      if (!deps.getStation() || !shouldRecover()) return false;
      if (reconnectTries >= maxReconnectTries()) return false;
      if (!canReconnectNow()) return false;

      const player = deps.getPlayer();
      const url = deps.getStreamUrl?.(deps.getStation());
      if (!url || !player) return false;

      reconnectTries += 1;
      lastReconnectAt = Date.now();

      deps.setSuppressErrors?.(true);
      try { player.load(); } catch {}
      deps.setSuppressErrors?.(false);
      player.src = url;
      player.play().catch(() => {});
      startKeepalive();
      return true;
    }

    function resetReconnectTries() {
      reconnectTries = 0;
    }

    function getMobilePreload(stationResilient) {
      return IS_MOBILE || stationResilient ? 'auto' : 'none';
    }

    return {
      IS_MOBILE,
      isBackground,
      shouldRecover,
      maxReconnectTries,
      getMobilePreload,
      setupLifecycle,
      attachToPlayer,
      startKeepalive,
      stopKeepalive,
      onPlayStart,
      onPlayStop,
      onUserPause,
      onPlaying,
      onStall,
      shouldHandleEnded,
      shouldHandleError,
      attemptReconnect,
      resetReconnectTries,
      getReconnectTries: () => reconnectTries,
      showReconnectFailed: () => !isBackground(),
    };
  }

  global.RadarMobilePlayback = { create: createMobilePlayback, CONFIG: DEFAULT_CONFIG };
})(typeof window !== 'undefined' ? window : globalThis);