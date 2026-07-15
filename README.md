# LE RADAR — Les médias étudiants du Québec

> *Les médias étudiants du Québec, sur ton radar • Student media on your radar.*

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://azdak919.github.io/radios-etudiantes-qc/)
![PWA](https://img.shields.io/badge/PWA-ready-blue)
![License](https://img.shields.io/badge/license-GPL--2.0-green)

**LE RADAR** est une application web progressive (PWA) **éditoriale, texte d'abord** qui rassemble en un seul endroit **les radios et les journaux étudiants** des cégeps et universités du Québec. Une page unique : un **syntoniseur radio** en tête, et le **fil des actualités étudiantes** en dessous.

**→ [Essayer LE RADAR maintenant](https://azdak919.github.io/radios-etudiantes-qc/)**

> Projet non officiel. Le Radar n’est affilié à aucun des médias listés.

---

## ✨ Fonctionnalités

- **Design éditorial, texte d'abord** — titres, brèves et hiérarchie visuelle (manchette « À la une »)
- **Syntoniseur radio** collant : choix du poste, lecture native (flux HTTPS), volume, Media Session API
- **Postes natifs** — écoute directe sur Le Radar pour les stations avec flux validé (ex. CHYZ, CISM, CKUT, CJLO, CFAK)
- **Fil étudiant** — agrégation RSS des journaux étudiants, filtrable par source
- **Identité couleur par établissement** — pastilles sources, accents radio et marques institutionnelles (`brand-colors.json`)
- **« À l'antenne »** — émission en cours selon la grille horaire colligée (bot) + titre live via métadonnées ICY du flux
- **Bots automatisés** — agrégation des articles, images vedette, crédits photo, découverte de flux radio, horaires
- **Mode clair / sombre** persistant
- **PWA** — installation mobile, service worker, offline shell
- **100 % statique** — `news.json` et `radios.json` reconstruits par GitHub Actions ; pas de backend

---

## 🎨 Identité visuelle

La charte de marque est documentée dans **[`docs/identite-visuelle.md`](docs/identite-visuelle.md)**.

En bref — **pourpre `#6C2163`** = marque, **rouge `#C8102E`** = en direct, **bleu Québec `#003DA5`** = volet radio. Source de vérité : variables CSS dans `style.css`.

---

## 🚀 Démarrage rapide (local)

```bash
git clone https://github.com/azdak919/radios-etudiantes-qc.git
cd radios-etudiantes-qc

python -m http.server 8080
# ou
npx serve .
```

Ouvre **http://localhost:8080** — déploiement direct sur GitHub Pages (push sur `main`).

---

## 📊 Structure du projet

```
radios-etudiantes-qc/
├── index.html              # Page principale (fil + syntoniseur)
├── feeds.html              # Page des flux RSS LE RADAR
├── style.css               # Styles (clair / sombre, radio, fil)
├── app.js                  # Logique client (tuner, fil, PWA)
├── radios.json             # Registre des radios étudiantes
├── news.json               # Fil agrégé (généré par bot)
├── news-sources.json       # Registre des sources d'actualités
├── brand-colors.json       # Couleurs institutionnelles
├── manifest.json           # PWA
├── sw.js                   # Service Worker
├── scripts/                # Bots (fetch, images, flux, maintenance)
├── assets/                 # Icônes et logos
└── docs/                   # Documentation (sources, identité)
```

---

## ➕ Ajouter ou mettre à jour une radio

1. Ouvre `radios.json`
2. Ajoute ou modifie une entrée (`id`, `name`, `institution`, `stream`, `website`, etc.)
3. Lance `node scripts/discover-streams.js --update` pour valider ou découvrir un flux direct

Voir aussi `radios-candidates.json` pour les postes en cours de validation.

### 📅 Horaires « à l'antenne »

Le bandeau **À l'antenne** affiche l'émission en cours selon l'heure. La grille
hebdomadaire de chaque poste est colligée par `scripts/fetch-radio-schedules.js`
depuis plusieurs sources via des adaptateurs (`airtime`, `chyz`, `cfak`,
`jsonld`, `spinitron`) et des grilles manuelles dans `radio-schedules.seed.json`,
puis écrite dans `radio-schedules.json` (lu par le site).

`scripts/discover-schedule-sources.js` **automatise la recherche et l'entretien
des sources** : il revalide les sources existantes, sonde les pages d'horaire
pour en trouver de nouvelles, détecte les plateformes connues (Spinitron) et
rapporte la santé. Les deux bots tournent **aux deux semaines**. Détails et
format : [`docs/maintenance.md`](docs/maintenance.md#horaires--à-lantenne).

---

## 📰 Fil d’actualités + bots

Le fil est **statique** : les bots GitHub Actions écrivent `news.json` ; le site ne fait que le lire.

| Bot | Script | Rôle |
|-----|--------|------|
| Fil d'actualités | `scripts/fetch-news.js` | RSS → `news.json` |
| Mainteneur sources | `scripts/discover-news-sources.js` | Santé et promotion des flux |
| Images vedette | `scripts/ensure-lead-images.js` | Photos source, stock Openverse, QC |
| Flux radio | `scripts/discover-streams.js` | Validation et découverte de streams |

Registre éditable : `news-sources.json` (`active`, `candidates`, `botHints` par source).

Documentation : [`docs/adding-news-source.md`](docs/adding-news-source.md)

---

## 🎙️ Proxy audio (optionnel)

Pour les flux HTTP ou CORS difficiles, un Cloudflare Worker léger est fourni dans `proxy/cloudflare-worker.js`. Déploie-le, puis renseigne l’URL en tête de `app.js` :

```js
const PROXY_BASE = 'https://ton-worker.workers.dev';
```

---

## 🛠️ Stack technique

- HTML5, CSS maison, JavaScript vanilla
- Service Worker + Web App Manifest
- `new Audio()` + Media Session API
- Node.js pour les bots (CI GitHub Actions)

Aucun framework front-end, aucun build step obligatoire.

---

## 🤝 Contribuer

1. Fork le projet
2. Branche (`git checkout -b feature/ma-contribution`)
3. Teste localement
4. Pull Request

Signale aussi les liens cassés, flux morts ou sources manquantes.

---

## Crédits et contenus

**Conçu avec ♡ par [Azdak](https://www.buymeacoffee.com/azdak) en 2026**

Code libre utilisé conformément aux licences applicables; contenus et médias crédités à leurs auteurs respectifs.

🤖 **Agrégateur automatisé de contenus** — Le Radar collecte et reformate des publications étudiantes tierces (titres, brèves, liens, métadonnées). Chaque article renvoie vers sa source originale. Les radios et journaux listés restent propriété de leurs équipes respectives.

---

## 📄 Licence

Le code de ce dépôt est distribué sous **[GNU General Public License v2](LICENSE)**.

Les articles, photos, flux audio et marques des médias étudiants cités appartiennent à leurs auteurs et éditeurs respectifs.

---

**Merci à toutes les radios et rédactions étudiantes qui font vibrer les campus du Québec !** 🎧📰