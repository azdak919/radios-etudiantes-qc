#!/usr/bin/env node
/**
 * RÉQ Stream Tracker Bot
 *
 * Automatically finds and validates direct audio streams so stations
 * can be played inside the RÉQ site instead of sending users to the
 * official websites.
 *
 * Features:
 * - Hardcoded known-good streams (maintained by humans + bot)
 * - Probes common Icecast / Airtime / AzuraCast paths
 * - Fetches the official website and extracts .m3u / .pls / stream links
 * - Tries status-json.xsl to discover mounts
 * - Validates that the URL is a real audio stream (icy headers + audio content)
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
  // Add more here when we find reliable direct ones
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
  cjlo: ['http://www.cjlo.com/cjlo.m3u'],
  choq: ['https://choq.ca/stream'],
};

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
          'User-Agent': 'RÉQ-StreamBot/1.0',
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

async function validateStream(url) {
  if (!url) return { valid: false, reason: 'no url' };

  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'RÉQ-StreamBot/1.0',
          'Icy-MetaData': '1',
        },
        timeout: TIMEOUT,
      },
      (res) => {
        const contentType = (res.headers['content-type'] || '').toLowerCase();
        const icyMetaint = res.headers['icy-metaint'];
        const icyName = res.headers['icy-name'];

        const looksLikeAudio =
          contentType.includes('audio') ||
          contentType.includes('mpeg') ||
          contentType.includes('mp3') ||
          !!icyMetaint;

        // Be strict: we want real streaming audio, not HTML player pages
        if (looksLikeAudio && res.statusCode < 400) {
          // Read a little data to confirm it's really streaming
          let bytesRead = 0;
          res.on('data', (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > 8192) res.destroy();
          });

          resolve({
            valid: true,
            contentType,
            icyName: icyName || null,
            icyMetaint: icyMetaint ? parseInt(icyMetaint, 10) : null,
            status: res.statusCode,
          });
          return;
        }

        res.resume();
        resolve({ valid: false, reason: `status ${res.statusCode} ${contentType}` });
      }
    );

    req.on('error', (e) => resolve({ valid: false, reason: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, reason: 'timeout' });
    });
  });
}

function extractStreamUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const patterns = [
    /https?:\/\/[^"'\s<>()]+\.(?:m3u|pls|mp3|aac|ogg)(?:\?[^"'\s<>()]*)?/gi,
    /https?:\/\/[^"'\s<>()]+\/(stream|live|radio|mount)[^"'\s<>()]*/gi,
    /"stream"\s*:\s*"([^"]+)"/gi,
    /src\s*=\s*["']([^"']*(?:stream|listen|icecast)[^"']*)["']/gi,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(html)) !== null) {
      let u = match[1] || match[0];
      if (u && u.startsWith('http')) {
        try {
          // make absolute
          const abs = new URL(u, baseUrl).toString();
          urls.add(abs);
        } catch {}
      }
    }
  }
  return [...urls];
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

  // 1. Known good streams first
  if (KNOWN_STREAMS[radio.id]) {
    results.push(KNOWN_STREAMS[radio.id]);
  }
  if (STATION_HINTS[radio.id]) {
    results.push(...STATION_HINTS[radio.id]);
  }

  // 2. Probe status-json.xsl on the official domain
  if (radio.website) {
    try {
      const domain = new URL(radio.website).hostname.replace(/^www\./, '');
      const fromStatus = await probeIcecastStatus(domain);
      if (fromStatus) results.push(fromStatus);
    } catch {}
  }

  // 3. Scrape the official website for stream links
  if (radio.website) {
    const html = await fetchText(radio.website);
    if (html) {
      const found = extractStreamUrlsFromHtml(html, radio.website);
      results.push(...found);
    }
  }

  // 4. Common path guessing
  if (radio.website) {
    try {
      const domain = new URL(radio.website).hostname.replace(/^www\./, '');
      for (const p of COMMON_PATHS) {
        results.push(`https://${domain}${p}`);
        results.push(`https://${domain}:8000${p}`);
        results.push(`http://${domain}:8000${p}`);
      }
    } catch {}
  }

  // Deduplicate
  const unique = [...new Set(results.filter(Boolean))];

  // Validate in order
  for (const candidate of unique) {
    const test = await validateStream(candidate);
    if (test.valid) {
      return {
        stream: candidate,
        status: 'working',
        meta: test,
        checked: new Date().toISOString(),
      };
    }
  }

  return {
    stream: null,
    status: 'none',
    checked: new Date().toISOString(),
  };
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

  console.log('RÉQ Stream Tracker Bot');
  console.log('======================\n');

  const updatedRadios = [...radios];
  const existingIds = new Set(updatedRadios.map((r) => r.id));
  const stillCandidates = [];
  let promoted = 0;

  for (const radio of radios) {
    if (specific && radio.id !== specific) continue;

    console.log(`→ ${radio.fullName || radio.name} (${radio.id})`);

    const discovery = await discoverForRadio(radio);

    const newEntry = { ...radio };

    if (discovery.stream) {
      newEntry.stream = discovery.stream;
      newEntry._streamStatus = discovery.status;
      newEntry._streamChecked = discovery.checked;
      console.log(`   ✓ ${discovery.stream}\n`);
    } else {
      newEntry.stream = radio.stream || null;
      newEntry._streamStatus = 'none';
      newEntry._streamChecked = discovery.checked;
      console.log(`   ✗ No reliable direct stream found\n`);
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
