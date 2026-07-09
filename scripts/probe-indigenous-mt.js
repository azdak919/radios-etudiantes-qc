#!/usr/bin/env node
/**
 * LE RADAR — sonde mensuelle des moteurs de traduction pour les langues
 * autochtones du Québec.
 *
 * Pour chaque langue de indigenous-mt.json :
 *   1. Google gtx (sans clé) — codes candidats
 *   2. Liste Microsoft Translator (présence du code)
 *   3. Liste LibreTranslate public
 *
 * Si un moteur répond de façon fiable (texte traduit ≠ source, pas d'erreur),
 * la langue est activée (enabled: true, goog/engine renseignés) pour que
 * translate.js l'intègre automatiquement au menu.
 *
 *   node scripts/probe-indigenous-mt.js
 *   node scripts/probe-indigenous-mt.js --dry-run
 *
 * Exit 0 toujours. Sortie « CHANGED=true|false » sur stdout pour le workflow.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const REG_PATH = path.join(ROOT, 'indigenous-mt.json');
const SAMPLE = 'Hello students. Welcome to the student news feed from Quebec universities and colleges.';
const dryRun = process.argv.includes('--dry-run');

function fetchText(url, { method = 'GET', body = null, headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        url,
        {
          method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; REQ-IndigenousMTProbe/1.0; +https://azdak919.github.io/radios-etudiantes-qc/)',
            Accept: 'application/json, text/plain, */*',
            ...headers,
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return done(fetchText(new URL(res.headers.location, url).toString(), {
              method, body, headers, timeoutMs,
            }));
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            data += c;
            if (data.length > 2_000_000) {
              req.destroy();
              done({ status: res.statusCode, body: data });
            }
          });
          res.on('end', () => done({ status: res.statusCode, body: data }));
          res.on('error', () => done({ status: 0, body: '' }));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done({ status: 0, body: '' });
      });
      req.on('error', () => done({ status: 0, body: '' }));
      if (body) req.write(body);
      req.end();
      setTimeout(() => {
        req.destroy();
        done({ status: 0, body: '' });
      }, timeoutMs + 500);
    } catch {
      done({ status: 0, body: '' });
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * gtx : succès si JSON valide, texte non vide, différent de la source,
 * et pas une simple copie (modèles qui « supportent » un code sans traduire).
 */
async function probeGtx(code) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(code)}&dt=t&q=${encodeURIComponent(SAMPLE)}`;
  const res = await fetchText(url, { timeoutMs: 12000 });
  if (res.status !== 200 || !res.body || res.body.startsWith('<')) {
    return { ok: false, reason: `http_${res.status || 'fail'}`, translated: '' };
  }
  try {
    const data = JSON.parse(res.body);
    const translated = (data?.[0] || []).map((s) => s?.[0]).filter(Boolean).join('').trim();
    if (!translated) return { ok: false, reason: 'empty', translated: '' };
    // Rejet si inchangé (code accepté mais pas de modèle)
    if (translated === SAMPLE) return { ok: false, reason: 'unchanged', translated };
    // Rejet si quasi-identique (casse)
    if (translated.toLowerCase() === SAMPLE.toLowerCase()) {
      return { ok: false, reason: 'unchanged_case', translated };
    }
    // Au moins quelques caractères non-ASCII ou mots différents
    const srcWords = new Set(SAMPLE.toLowerCase().split(/\W+/).filter(Boolean));
    const outWords = translated.toLowerCase().split(/\W+/).filter(Boolean);
    const overlap = outWords.filter((w) => srcWords.has(w)).length;
    const ratio = outWords.length ? overlap / outWords.length : 1;
    if (ratio > 0.85 && !/[^\u0000-\u007f]/.test(translated)) {
      return { ok: false, reason: 'too_similar', translated: translated.slice(0, 80) };
    }
    return { ok: true, reason: 'ok', translated: translated.slice(0, 120), code };
  } catch {
    return { ok: false, reason: 'parse_error', translated: '' };
  }
}

async function probeMicrosoftList() {
  const res = await fetchText(
    'https://api.cognitive.microsofttranslator.com/languages?api-version=3.0',
    { timeoutMs: 12000 },
  );
  if (res.status !== 200) return { ok: false, codes: new Set() };
  try {
    const data = JSON.parse(res.body);
    const tr = data.translation || {};
    return { ok: true, codes: new Set(Object.keys(tr)), names: tr };
  } catch {
    return { ok: false, codes: new Set() };
  }
}

async function probeLibreTranslateList() {
  const res = await fetchText('https://libretranslate.com/languages', { timeoutMs: 12000 });
  if (res.status !== 200) return { ok: false, codes: new Set() };
  try {
    const data = JSON.parse(res.body);
    const codes = new Set((Array.isArray(data) ? data : []).map((x) => x.code).filter(Boolean));
    return { ok: true, codes };
  } catch {
    return { ok: false, codes: new Set() };
  }
}

function languageFingerprint(lang) {
  return JSON.stringify({
    enabled: !!lang.enabled,
    unavailable: !!lang.unavailable,
    goog: lang.goog || null,
    engine: lang.engine || null,
    hint: lang.hint || '',
  });
}

async function main() {
  const beforeFile = fs.readFileSync(REG_PATH, 'utf8');
  const reg = JSON.parse(beforeFile);
  const before = JSON.stringify(reg.languages.map(languageFingerprint));

  console.log('LE RADAR — probe indigenous MT engines');
  console.log('=====================================');

  const ms = await probeMicrosoftList();
  console.log('Microsoft list:', ms.ok ? `${ms.codes.size} langs` : 'fail');
  await sleep(200);
  const lt = await probeLibreTranslateList();
  console.log('LibreTranslate list:', lt.ok ? `${lt.codes.size} langs` : 'fail');

  const newlyEnabled = [];
  const stillWaiting = [];

  for (const lang of reg.languages || []) {
    const probe = {
      at: new Date().toISOString(),
      gtx: null,
      gtxCode: null,
      microsoft: false,
      libretranslate: false,
    };

    // Microsoft name/code presence (info only — pas d'API gratuite sans clé)
    const msCodes = lang.probeCodes?.microsoft || [];
    probe.microsoft = msCodes.some((c) => ms.codes.has(c));

    // LibreTranslate
    const gtxCandidates = lang.probeCodes?.gtx || [];
    probe.libretranslate = gtxCandidates.some((c) => lt.codes.has(c));

    // gtx — premier code qui traduit vraiment
    let gtxHit = null;
    for (const code of gtxCandidates) {
      await sleep(350);
      const result = await probeGtx(code);
      console.log(`  ${lang.id} gtx/${code}: ${result.ok ? 'OK' : result.reason}`);
      if (result.ok) {
        gtxHit = { code, ...result };
        break;
      }
    }
    if (gtxHit) {
      probe.gtx = true;
      probe.gtxCode = gtxHit.code;
      probe.sample = gtxHit.translated;
    } else {
      probe.gtx = false;
    }

    lang.lastProbe = probe;

    const wasEnabled = !!lang.enabled;
    if (gtxHit) {
      lang.enabled = true;
      lang.unavailable = false;
      lang.engine = 'gtx';
      lang.goog = gtxHit.code;
      // Mettre à jour le hint si on sort de « bientôt »
      if (/bientôt|attente/i.test(lang.hint || '')) {
        lang.hint = lang.hint.replace(/\s*·\s*bientôt/i, '').replace(/\s*—\s*en attente.*/i, '') + ' · auto';
      }
      if (!wasEnabled) newlyEnabled.push(`${lang.id}→gtx/${gtxHit.code}`);
      console.log(`  ✓ ${lang.id} ENABLED via gtx/${gtxHit.code}`);
    } else {
      // Ne jamais désactiver l'inuktitut déjà validé manuellement si le probe
      // échoue temporairement (réseau). Pour les autres : rester unavailable.
      if (lang.id === 'iu' || lang.id === 'iu-latn') {
        lang.enabled = true;
        lang.unavailable = false;
        lang.engine = lang.engine || 'gtx';
        lang.goog = lang.goog || (lang.id === 'iu' ? 'iu' : 'iu');
        console.log(`  · ${lang.id} kept enabled (baseline Inuktut)`);
      } else {
        lang.enabled = false;
        lang.unavailable = true;
        lang.engine = null;
        lang.goog = null;
        if (!/bientôt/i.test(lang.hint || '')) {
          lang.hint = (lang.hint || lang.label) + (lang.hint?.includes('·') ? '' : ' · bientôt');
        }
        stillWaiting.push(lang.id);
        console.log(`  · ${lang.id} still waiting`);
      }
    }
  }

  reg.probedAt = new Date().toISOString();
  reg.updated = reg.probedAt;
  reg.engines = reg.engines || {};
  reg.engines.gtx = { ...(reg.engines.gtx || {}), lastCheck: reg.probedAt, ok: true };
  reg.engines.microsoft_list = {
    ...(reg.engines.microsoft_list || {}),
    lastCheck: reg.probedAt,
    ok: ms.ok,
    count: ms.codes?.size || 0,
  };
  reg.engines.libretranslate = {
    ...(reg.engines.libretranslate || {}),
    lastCheck: reg.probedAt,
    ok: lt.ok,
    count: lt.codes?.size || 0,
  };

  // Historique court (12 sondes max)
  reg.history = Array.isArray(reg.history) ? reg.history : [];
  reg.history.unshift({
    at: reg.probedAt,
    newlyEnabled,
    stillWaiting,
    microsoftOk: ms.ok,
    libreOk: lt.ok,
  });
  reg.history = reg.history.slice(0, 12);

  const after = JSON.stringify(reg.languages.map(languageFingerprint));
  const out = `${JSON.stringify(reg, null, 2)}\n`;
  // Toujours committer le journal de sonde (probedAt / history), même sans
  // nouvelle langue — permet de voir que le bot mensuel a bien tourné.
  const changed = beforeFile !== out || before !== after || newlyEnabled.length > 0;

  if (!dryRun) {
    fs.writeFileSync(REG_PATH, out);
    console.log(`Wrote ${path.relative(ROOT, REG_PATH)}`);
  } else {
    console.log('(dry-run — not written)');
  }

  console.log('');
  console.log(newlyEnabled.length ? `Newly enabled: ${newlyEnabled.join(', ')}` : 'No new engines this run.');
  console.log(`CHANGED=${changed ? 'true' : 'false'}`);
  // Pour le workflow GH Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed ? 'true' : 'false'}\n`);
    if (newlyEnabled.length) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `newly_enabled=${newlyEnabled.join(',')}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
