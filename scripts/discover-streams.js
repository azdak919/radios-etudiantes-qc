#!/usr/bin/env node
/**
 * LE RADAR Stream Tracker Bot
 *
 * Automatically finds and validates direct audio streams so stations
 * can be played inside the LE RADAR site instead of sending users to the
 * official websites.
 *
 * Features:
 * - Hardcoded known-good streams (maintained by humans + bot)
 * - Probes common Icecast / Airtime / AzuraCast / Radio.co / RadioMast paths
 * - Scrape site + pages lecteur (/player.html, listenUrl) pour flux cachés
 * - Upgrade HTTP → HTTPS (ex. shoutca.st → *.radioca.st/stream, CJLO)
 * - Préfère les flux HTTPS avec CORS pour lecture native dans le PWA
 * - Retire listenUrl/listenHint quand un flux direct est validé
 *
 * Usage:
 *   node scripts/discover-streams.js
 *   node scripts/discover-streams.js --update
 *   node scripts/discover-streams.js --radio ckut
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const RADIOS_PATH = path.join(__dirname, '..', 'radios.json');
const CANDIDATES_PATH = path.join(__dirname, '..', 'radios-candidates.json');
const TIMEOUT = 9000;

// === KNOWN GOOD STREAMS (the bot trusts and re-validates these first) ===
const KNOWN_STREAMS = {
  chyz: 'https://ecoutez.chyz.ca/proxy/chyz943/stream',
  ckut: 'https://ckut.out.airtime.pro/ckut_a',
  // HTTPS mount — playable directly on the HTTPS site (the :8000 HTTP one is blocked as mixed content)
  cism: 'https://stream03.ustream.ca/cism128.mp3',
  cjlo: 'https://cjlo.radioca.st/stream',
};

// Per-station hints for faster/better discovery
const STATION_HINTS = {
  chyz: ['https://ecoutez.chyz.ca/proxy/chyz943/stream'],
  ckut: [
    'https://ckut.out.airtime.pro/ckut_a',
    'https://icecast.ckut.ca/903fm-192-stereo',
  ],
  cism: [
    'https://stream03.ustream.ca/cism128.mp3',
    'http://stream03.ustream.ca:8000/cism128.mp3',
    'https://cism893.ca/stream',
  ],
  cfou: [
    'http://streamer.xittel.net:8000/cfou',
  ],
  cfak: ['https://cfak.ca/stream'],
  cjlo: [
    'https://cjlo.radioca.st/stream',
    'http://rosetta.shoutca.st:8883/stream',
    'http://www.cjlo.com/player.html',
  ],
  choq: [
    'https://streams.radiomast.io/a372c74f-6c78-48b9-9933-81a8fc50b54a',
    'https://choq.ca/stream',
  ],
};

const PLAYER_PAGE_PATHS = [
  '/player.html',
  '/player',
  '/ecouter',
  '/listen',
  '/live',
  '/radio',
];

const HOSTING_PLATFORM_SUFFIXES = [
  (id) => `https://${id}.radioca.st/stream`,
  (id) => `https://${id}.out.airtime.pro/${id}_a`,
  (slug) => `https://streams.radiomast.io/${slug}`,
];

// Common paths the bot will try on the main domain
const COMMON_PATHS = [
  '/stream',
  '/live',
  '/radio',
  '/mp3',
  '/;stream.mp3',
  '/stream.mp3',
  '/listen',
  '/;',
  '/mount',
];

async function fetchText(url, accept = '*/*') {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'LE-RADAR-StreamBot/1.0',
          'Accept': accept,
        },
        timeout: TIMEOUT,
      },
      (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          return resolve('');
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

function hasCors(headers = {}) {
  const origin = headers['access-control-allow-origin'];
  return origin === '*' || origin === '*, *';
}

function isAudioResponse(res) {
  const contentType = (res.headers['content-type'] || '').toLowerCase();
  const icyMetaint = res.headers['icy-metaint'];
  return (
    contentType.includes('audio')
    || contentType.includes('mpeg')
    || contentType.includes('mp3')
    || !!icyMetaint
  );
}

async function validateStream(url, redirects = 0) {
  if (!url) return { valid: false, reason: 'no url' };
  if (redirects > 4) return { valid: false, reason: 'too many redirects' };

  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'LE-RADAR-StreamBot/1.0',
          'Icy-MetaData': '1',
        },
        timeout: TIMEOUT,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(validateStream(next, redirects + 1));
          return;
        }

        const contentType = (res.headers['content-type'] || '').toLowerCase();
        const icyMetaint = res.headers['icy-metaint'];
        const icyName = res.headers['icy-name'];

        if (isAudioResponse(res) && res.statusCode < 400) {
          let bytesRead = 0;
          res.on('data', (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > 8192) res.destroy();
          });
          const done = () => resolve({
            valid: true,
            url,
            contentType,
            icyName: icyName || null,
            icyMetaint: icyMetaint ? parseInt(icyMetaint, 10) : null,
            status: res.statusCode,
            cors: hasCors(res.headers),
            https: url.startsWith('https:'),
          });
          res.on('close', done);
          res.on('end', done);
          return;
        }

        res.resume();
        resolve({ valid: false, reason: `status ${res.statusCode} ${contentType}` });
      },
    );

    req.on('error', (e) => resolve({ valid: false, reason: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, reason: 'timeout' });
    });
  });
}

function normalizeStationLabel(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const KNOWN_STATION_SLUGS = ['chyz', 'cism', 'ckut', 'cjlo', 'cfou', 'cfak', 'choq', 'cjep', 'crem'];

/** Évite d'assigner le flux d'un autre poste (ex. CFAK sur la page CHOQ). */
function streamMatchesStation(radio = {}, meta = {}) {
  const icy = normalizeStationLabel(meta.icyName || '');
  if (!icy) return true;

  const slug = slugFromRadio(radio);
  if (slug && icy.includes(slug)) return true;

  const nameCore = normalizeStationLabel(radio.name || radio.fullName || '')
    .split(/\s+/)
    .find((t) => t.length >= 4 && !/^\d/.test(t));
  if (nameCore && icy.includes(nameCore)) return true;

  for (const other of KNOWN_STATION_SLUGS) {
    if (other !== slug && icy.includes(other)) return false;
  }
  return true;
}

function rankStreamResult(result = {}, radio = {}) {
  let score = 0;
  if (result.https) score += 100;
  if (result.cors) score += 45;
  if (result.icyName) score += 8;
  if (streamMatchesStation(radio, result)) score += 60;
  else score -= 200;
  return score;
}

function slugFromRadio(radio = {}) {
  if (radio.id) return String(radio.id).toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    return new URL(radio.website).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return '';
  }
}

function expandStreamVariants(url = '') {
  const out = new Set([url]);
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') {
      const httpsUrl = new URL(url);
      httpsUrl.protocol = 'https:';
      out.add(httpsUrl.toString());
    }
    if (u.hostname.includes('shoutca.st') && u.pathname.includes('stream')) {
      const sub = u.hostname.split('.')[0];
      if (sub && sub !== 'www') {
        out.add(`https://${sub}.radioca.st/stream`);
      }
    }
  } catch {
    /* ignore */
  }
  return [...out];
}

function inferHostingUrls(radio = {}) {
  const slug = slugFromRadio(radio);
  if (!slug) return [];
  return HOSTING_PLATFORM_SUFFIXES.map((fn) => fn(slug)).filter(Boolean);
}

function isLikelyStreamUrl(url = '') {
  const u = String(url).toLowerCase();
  if (!u.startsWith('http')) return false;
  if (/\.(html?|php|asp|aspx)(\?|$)/.test(u)) return false;
  if (/radio\.garden|facebook\.com|instagram\.com|twitter\.com|youtube\.com/.test(u)) return false;
  return /stream|listen|icecast|airtime|radioca|shoutca|radiomast|xittel|\.m3u|\.pls|\/;/i.test(u)
    || /\.(mp3|aac|ogg)(\?|$)/i.test(u);
}

async function parsePlaylist(url) {
  const text = await fetchText(url);
  if (!text) return [];
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('http') && isLikelyStreamUrl(trimmed)) urls.push(trimmed);
    const fileMatch = trimmed.match(/^File\d+=(.+)$/i);
    if (fileMatch?.[1]?.startsWith('http')) urls.push(fileMatch[1].trim());
  }
  return urls;
}

function extractStreamUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const patterns = [
    /https?:\/\/[^"'\s<>()]+\.(?:m3u8?|pls|mp3|aac|ogg)(?:\?[^"'\s<>()]*)?/gi,
    /https?:\/\/[^"'\s<>()]+\.radioca\.st\/stream/gi,
    /https?:\/\/streams\.radiomast\.io\/[a-f0-9-]+/gi,
    /https?:\/\/[^"'\s<>()]+\.out\.airtime\.pro\/[^"'\s<>()]+/gi,
    /https?:\/\/streamer\.xittel\.net:\d+\/[^"'\s<>()]+/gi,
    /https?:\/\/[^"'\s<>()]+\/(?:stream|live|radio|mount|proxy\/[^"'\s<>()]+)[^"'\s<>()]*/gi,
    /"stream"\s*:\s*"([^"]+)"/gi,
    /src\s*=\s*["']([^"']*(?:stream|listen|icecast|shoutca|radioca|radiomast)[^"']*)["']/gi,
    /href\s*=\s*["']([^"']*(?:\.radioca\.st\/stream|streams\.radiomast\.io)[^"']*)["']/gi,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(html)) !== null) {
      let u = match[1] || match[0];
      if (u && u.startsWith('http') && isLikelyStreamUrl(u)) {
        try {
          urls.add(new URL(u, baseUrl).toString());
        } catch {
          /* ignore */
        }
      }
    }
  }
  return [...urls];
}

async function scrapePageForStreams(pageUrl, baseUrl = pageUrl) {
  const found = new Set();
  const html = await fetchText(pageUrl);
  if (!html) return [];

  for (const u of extractStreamUrlsFromHtml(html, baseUrl)) found.add(u);

  for (const streamUrl of [...found]) {
    if (/\.m3u8?$/i.test(streamUrl) || /\.pls$/i.test(streamUrl)) {
      for (const inner of await parsePlaylist(streamUrl)) found.add(inner);
    }
  }

  return [...found];
}

async function gatherPlayerPages(radio = {}) {
  const pages = new Set();
  if (radio.listenUrl) pages.add(radio.listenUrl);
  if (radio.website) {
    try {
      const base = new URL(radio.website);
      for (const path of PLAYER_PAGE_PATHS) {
        pages.add(new URL(path, base).toString());
      }
    } catch {
      /* ignore */
    }
  }
  return [...pages];
}

async function probeIcecastStatus(baseDomain) {
  const candidates = [
    `https://${baseDomain}/status-json.xsl`,
    `http://${baseDomain}/status-json.xsl`,
    `https://${baseDomain}:8000/status-json.xsl`,
    `http://${baseDomain}:8000/status-json.xsl`,
  ];

  for (const url of candidates) {
    const text = await fetchText(url, 'application/json');
    if (!text) continue;

    try {
      const data = JSON.parse(text);
      const sources = data?.icestats?.source;
      if (sources) {
        const list = Array.isArray(sources) ? sources : [sources];
        for (const s of list) {
          if (s?.listenurl) return s.listenurl;
          if (s?.url) return s.url;
        }
      }
    } catch {}
  }
  return null;
}

async function discoverForRadio(radio) {
  const results = [];

  if (KNOWN_STREAMS[radio.id]) results.push(KNOWN_STREAMS[radio.id]);
  if (STATION_HINTS[radio.id]) results.push(...STATION_HINTS[radio.id]);
  results.push(...inferHostingUrls(radio));

  if (radio.website) {
    try {
      const domain = new URL(radio.website).hostname.replace(/^www\./, '');
      const fromStatus = await probeIcecastStatus(domain);
      if (fromStatus) results.push(fromStatus);
    } catch {
      /* ignore */
    }
  }

  if (radio.website) {
    results.push(...await scrapePageForStreams(radio.website, radio.website));
  }

  for (const pageUrl of await gatherPlayerPages(radio)) {
    results.push(...await scrapePageForStreams(pageUrl, radio.website || pageUrl));
  }

  if (radio.website) {
    try {
      const domain = new URL(radio.website).hostname.replace(/^www\./, '');
      for (const p of COMMON_PATHS) {
        results.push(`https://${domain}${p}`);
        results.push(`https://${domain}:8000${p}`);
        results.push(`http://${domain}:8000${p}`);
      }
    } catch {
      /* ignore */
    }
  }

  const expanded = results.flatMap((u) => expandStreamVariants(u));
  const unique = [...new Set(expanded.filter((u) => u && isLikelyStreamUrl(u)))];

  const valid = [];
  for (const candidate of unique) {
    const test = await validateStream(candidate);
    if (test.valid && streamMatchesStation(radio, test)) valid.push(test);
  }

  if (!valid.length) {
    return {
      stream: null,
      status: 'none',
      checked: new Date().toISOString(),
    };
  }

  valid.sort((a, b) => rankStreamResult(b, radio) - rankStreamResult(a, radio));
  const best = valid[0];
  return {
    stream: best.url,
    status: 'working',
    meta: best,
    alternates: valid.slice(1, 4).map((v) => v.url),
    checked: new Date().toISOString(),
  };
}

function applyStreamToRadio(radio, discovery) {
  const entry = { ...radio };
  if (discovery.stream) {
    entry.stream = discovery.stream;
    entry._streamStatus = discovery.status;
    entry._streamChecked = discovery.checked;
    if (discovery.meta?.icyName) entry._streamIcyName = discovery.meta.icyName;
    delete entry.listenUrl;
    delete entry.listenHint;
    return entry;
  }
  entry.stream = radio.stream || null;
  entry._streamStatus = radio.stream ? 'working' : 'none';
  entry._streamChecked = discovery.checked;
  return entry;
}

function slugFromCandidate(c) {
  const base = (c.id || c.name || 'radio').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 40);
}

function promoteCandidate(cand, discovery) {
  const id = slugFromCandidate(cand);
  return {
    id,
    name: cand.name,
    fullName: cand.name,
    institution: cand.institution,
    city: cand.region || '',
    region: cand.region || '',
    type: cand.type || 'universite',
    frequency: 'Web',
    website: cand.website,
    logo: '',
    stream: discovery.stream,
    description: `Radio étudiante découverte automatiquement (${cand.institution}).`,
    instagram: '',
    facebook: '',
    tags: ['auto-discovered'],
    _streamStatus: discovery.status,
    _streamChecked: discovery.checked,
    _discoveredFrom: cand.discoveredFrom || cand.website,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const doUpdate = args.includes('--update');
  const specific = args.find((a) => a.startsWith('--radio='))?.split('=')[1];

  const radios = JSON.parse(fs.readFileSync(RADIOS_PATH, 'utf8'));
  let candidateRegistry = { candidates: [] };
  try {
    candidateRegistry = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  } catch {}

  console.log('LE RADAR Stream Tracker Bot');
  console.log('======================\n');

  const updatedRadios = [...radios];
  const existingIds = new Set(updatedRadios.map((r) => r.id));
  const stillCandidates = [];
  let promoted = 0;

  for (const radio of radios) {
    if (specific && radio.id !== specific) continue;

    console.log(`→ ${radio.fullName || radio.name} (${radio.id})`);

    const discovery = await discoverForRadio(radio);
    const newEntry = applyStreamToRadio(radio, discovery);

    if (discovery.stream) {
      const tags = [
        discovery.meta?.https ? 'HTTPS' : 'HTTP',
        discovery.meta?.cors ? 'CORS' : null,
        discovery.meta?.icyName ? `ICY:${discovery.meta.icyName}` : null,
      ].filter(Boolean).join(', ');
      console.log(`   ✓ ${discovery.stream}${tags ? ` (${tags})` : ''}`);
      if (radio.listenUrl && !newEntry.listenUrl) {
        console.log('   ↻ listenUrl retiré — lecture native');
      }
      if (discovery.alternates?.length) {
        console.log(`   · ${discovery.alternates.length} alternative(s) HTTPS trouvée(s)`);
      }
      console.log('');
    } else {
      console.log('   ✗ No reliable direct stream found\n');
    }

    updatedRadios[updatedRadios.findIndex((r) => r.id === radio.id)] = newEntry;
  }

  // Probe radio candidates → auto-promote when a direct stream validates
  const candidates = candidateRegistry.candidates || [];
  if (candidates.length) {
    console.log('▸ Radio candidates\n');
  }

  for (const cand of candidates) {
    const pseudo = {
      id: slugFromCandidate(cand),
      name: cand.name,
      fullName: cand.name,
      website: cand.website,
    };
    console.log(`  ? ${cand.name} (${cand.institution})`);
    const discovery = await discoverForRadio(pseudo);

    if (discovery.stream) {
      const entry = promoteCandidate(cand, discovery);
      if (!existingIds.has(entry.id)) {
        updatedRadios.push(entry);
        existingIds.add(entry.id);
        promoted++;
        console.log(`    ⬆ PROMOTED → ${discovery.stream}\n`);
      } else {
        console.log(`    · id "${entry.id}" already listed\n`);
      }
    } else {
      cand._failCount = (cand._failCount || 0) + 1;
      cand._lastChecked = new Date().toISOString();
      stillCandidates.push(cand);
      console.log(`    ✗ no stream (${cand._failCount} tries)\n`);
    }
  }

  candidateRegistry.candidates = stillCandidates;
  candidateRegistry._lastRun = new Date().toISOString();

  if (promoted) console.log(`Promoted ${promoted} radio candidate(s) to radios.json.`);

  if (doUpdate) {
    fs.writeFileSync(RADIOS_PATH, JSON.stringify(updatedRadios, null, 2) + '\n');
    fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidateRegistry, null, 2) + '\n');
    console.log('✅ radios.json + radios-candidates.json updated.');
  } else {
    console.log('Dry-run complete. Use --update to persist changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
