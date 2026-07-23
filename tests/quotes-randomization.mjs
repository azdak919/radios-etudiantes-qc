#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

let seed = 0x5f3759df;
const seededMath = Object.create(Math);
seededMath.random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
};

const storage = new Map();
const context = {
  console,
  Math: seededMath,
  window: {},
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
};
vm.createContext(context);
vm.runInContext(`${read('pomo/js/storage.js')}\n${read('pomo/js/quotes-data.js')}`, context);
vm.runInContext(`${read('pomo/js/quotes-i18n.js')}\n${read('pomo/js/quotes-expansion.js')}\nthis.__quotes = QUOTES;\nthis.__quoteI18n = QUOTE_I18N;`, context);
vm.runInContext(read('pomo/js/quotes.js'), context);

const quotes = context.__quotes;
const translations = context.__quoteI18n;
const api = context.window.AtaraxiaQuotes;

assert.equal(quotes.length, 200, 'le catalogue enrichi doit contenir 200 citations');
assert.equal(new Set(quotes.map((quote) => quote.id)).size, quotes.length, 'identifiants de citations uniques requis');
assert.equal(new Set(quotes.map((quote) => quote.text)).size, quotes.length, 'textes de citations uniques requis');

const allowedCategories = new Set(['stoic', 'buddhist', 'tao-zen', 'world-wisdom', 'indigenous']);
for (const quote of quotes) {
  assert(quote.id && quote.text && quote.authorEn, `citation complète requise: ${quote.id || 'sans identifiant'}`);
  assert(allowedCategories.has(quote.category), `catégorie invalide pour ${quote.id}: ${quote.category}`);
  assert(!Object.hasOwn(quote, 'verificationStatus'), `statut technique superflu pour ${quote.id}`);
}

const sourcedIndigenous = quotes.filter((quote) =>
  quote.category === 'indigenous' && quote.sourceUrl
);
assert.equal(sourcedIndigenous.length, 39, '39 voix autochtones sourcées sont requises');
for (const quote of sourcedIndigenous) {
  assert(quote.people, `peuple ou nation requis pour ${quote.id}`);
  assert(quote.sourceTitle, `titre de source requis pour ${quote.id}`);
  assert.doesNotThrow(() => new URL(quote.sourceUrl), `URL de source valide requise pour ${quote.id}`);
  assert.equal(new URL(quote.sourceUrl).protocol, 'https:', `source HTTPS requise pour ${quote.id}`);
  assert(translations[quote.id]?.fr?.text, `traduction française requise pour ${quote.id}`);
  assert(translations[quote.id]?.fr?.author, `attribution française requise pour ${quote.id}`);
}

const categoryCounts = Object.fromEntries(
  [...allowedCategories].map((category) => [
    category,
    quotes.filter((quote) => quote.category === category).length,
  ])
);
assert.deepEqual(categoryCounts, {
  stoic: 73,
  buddhist: 39,
  'tao-zen': 12,
  'world-wisdom': 19,
  indigenous: 57,
}, 'les proportions historiques doivent être conservées');

for (const prefix of ['ind-08-', 'ind-09-']) {
  const quote = quotes.find((entry) => entry.id.startsWith(prefix));
  assert.equal(quote?.category, 'world-wisdom', `${prefix} ne doit plus être classé comme autochtone`);
}

const recent = [];
let indigenousCount = 0;
let nonIndigenousRun = 0;
let longestNonIndigenousRun = 0;

for (let draw = 0; draw < 1200; draw += 1) {
  const index = api.getRandomQuoteIndex();
  assert(!recent.slice(-26).includes(index), `répétition dans la fenêtre de 26 au tirage ${draw}`);
  api.recordQuoteSeen(index);
  recent.push(index);

  if (quotes[index].category === 'indigenous') {
    indigenousCount += 1;
    nonIndigenousRun = 0;
  } else {
    nonIndigenousRun += 1;
    longestNonIndigenousRun = Math.max(longestNonIndigenousRun, nonIndigenousRun);
  }
}

const indigenousShare = indigenousCount / 1200;
assert(longestNonIndigenousRun <= 4, `séquence non autochtone trop longue: ${longestNonIndigenousRun}`);
assert(indigenousShare >= 0.22 && indigenousShare <= 0.38,
  `part autochtone inattendue: ${(indigenousShare * 100).toFixed(1)} %`);

console.log(
  `OK citations (${quotes.length}, ${sourcedIndigenous.length} autochtones sourcées, `
  + `${(indigenousShare * 100).toFixed(1)} %, séquence max ${longestNonIndigenousRun})`
);
