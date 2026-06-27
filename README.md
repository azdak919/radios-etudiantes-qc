# RÉQ — Radios Étudiantes du Québec

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://azdak919.github.io/radios-etudiantes-qc/)
![PWA](https://img.shields.io/badge/PWA-ready-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**RÉQ** est une application web progressive (PWA) **simple, belle et parfaitement optimisée mobile** qui rassemble **toutes les radios étudiantes** des cégeps et universités du Québec en un seul endroit.

**→ [Essayer RÉQ maintenant](https://azdak919.github.io/radios-etudiantes-qc/)**

> Projet non officiel et collaboratif. RÉQ n’est affilié à aucune des stations listées.

---

## ✨ Fonctionnalités

- **Interface magnifique et mobile-first** — Design glassmorphism moderne, typographie soignée et animations fluides
- **Deux sections** via une navigation segmentée :
  - 📻 **Radios** — le répertoire avec filtres puissants :
    - Par type (Universités / Cégeps / Tous)
    - Par région (Montréal, Québec, Estrie, Saguenay, etc.)
    - Favoris (♥)
  - 📰 **Actualités étudiantes** — un fil de nouvelles agrégeant les flux RSS des journaux étudiants (Quartier Libre, Montréal Campus, Le Délit, The McGill Daily, The Link, Zone Campus…), filtrable par source
- **Cartes claires et informatives** : nom, fréquence, institution, ville + indicateur "LIVE" quand un flux direct est disponible
- **Lecteur audio intégré** dans le modal pour les stations qui fournissent un flux HTTPS public (ex: CHYZ, CKUT)
- **Modal riche** avec description, liens sociaux, site officiel et informations pratiques
- Bouton **« Radio aléatoire »**
- Favoris persistants (localStorage)
- Support **PWA complet** : installation sur mobile, icônes, offline shell, Media Session API (contrôles sur l’écran de verrouillage)
- **Très léger** : site statique, Tailwind via CDN, JavaScript vanilla pur
- **100 % sans serveur** : le fil de nouvelles est reconstruit par un bot GitHub Actions (`scripts/fetch-news.js`) qui écrit `news.json` — aucune requête CORS côté navigateur

---

## 📸 Aperçu

Ouvre l’application sur ton téléphone ou dans un navigateur desktop :

- Grille responsive (1 à 4 colonnes)
- Navigation segmentée Radios / Actualités
- Filtres ultra-réactifs (type, région, source de nouvelles)
- Modal qui s’ouvre parfaitement sur mobile
- Lecteur avec visualiseur d’égaliseur quand tu écoutes en direct

---

## 🚀 Démarrage rapide (local)

```bash
# Clone le repo
git clone https://github.com/azdak919/radios-etudiantes-qc.git
cd radios-etudiantes-qc

# Serveur local simple
python -m http.server 8080
# ou
npx serve .
```

Ouvre ensuite **http://localhost:8080**

L’application est prête à être déployée directement sur GitHub Pages (juste push sur `main`).

---

## 📊 Structure du projet

```
radios-etudiantes-qc/
├── index.html          # Interface complète (HTML + Tailwind config inline)
├── style.css           # Styles glass + player + responsive
├── app.js              # Toute la logique (grille, filtres, modal, lecteur audio, favoris, PWA)
├── radios.json         # ⭐ La source de vérité — liste des radios
├── manifest.json       # Configuration PWA
├── sw.js               # Service Worker (cache shell)
├── assets/             # Icônes (192/512 + SVG)
└── README.md
```

Les anciens fichiers spécifiques à CHYZ+ ont été supprimés du projet actif.

---

## ➕ Ajouter ou mettre à jour une radio

**C’est la partie la plus importante pour contribuer !**

1. Ouvre `radios.json`
2. Ajoute ou modifie un objet dans le tableau.

### Schéma complet

```json
{
  "id": "chyz",
  "name": "CHYZ 94.3",
  "fullName": "CHYZ 94.3 FM",
  "institution": "Université Laval",
  "city": "Québec",
  "region": "Capitale-Nationale",
  "type": "universite",
  "frequency": "94.3 FM",
  "website": "https://chyz.ca/",
  "stream": "https://...",               // ← Flux direct (découvert par le bot)
  "description": "...",
  "instagram": "...",
  "tags": ["musique", "local"]
}
```

**Conseils pour le flux audio :**
- Le bot essaie automatiquement de trouver et valider les flux directs.
- Priorité aux flux HTTPS + Icecast (avec en-têtes `icy-*`).

---

## 🤖 Stream Tracker Bot (écoute directement sur le site)

Le plus gros défi des radios étudiantes : **la plupart n’exposent pas de flux direct public facile**.

**Solution mise en place :**

### 1. Bot de découverte automatique
- `scripts/discover-streams.js` : un bot Node.js qui :
  - Valide les flux existants
  - Essaie de découvrir de nouveaux flux (patterns Icecast, Airtime, scraping basique)
  - Vérifie que le flux est vraiment de l’audio (en-têtes `icy-metaint`, `Content-Type`)
- Déclenché automatiquement tous les jours via GitHub Actions (`.github/workflows/update-streams.yml`)
- Peut aussi être lancé manuellement : `node scripts/discover-streams.js --update`

Exemple de flux trouvé par le bot :
- CKUT → `https://ckut.out.airtime.pro/ckut_a` (validé)

### 2. Proxy pour écouter 100% sur RÉQ (recommandé)

Même quand le bot trouve un flux direct, on rencontre souvent :
- HTTP (au lieu de HTTPS)
- Problèmes CORS
- Blocage mixed-content sur mobile

**Solution** : un tout petit proxy gratuit (Cloudflare Worker).

#### Déploiement du proxy (étapes précises)

1. Va sur https://dash.cloudflare.com
2. Dans la barre latérale → **Workers & Pages** → **Create Worker**
3. Clique **Deploy** (ne modifie rien pour l’instant)
4. Une fois déployé, clique sur **Edit code**
5. Supprime tout le code existant et colle le contenu du fichier `proxy/cloudflare-worker.js`
6. Clique **Deploy** (en haut à droite)
7. En haut de la page, copie l’URL du worker (exemple : `https://req-streams-abc123.workers.dev`)

#### Activation dans RÉQ

Dans `app.js`, tout en haut du fichier, modifie cette ligne :

```js
const PROXY_BASE = 'https://req-streams-abc123.workers.dev';
```

C’est tout.

Désormais, quand un flux est disponible, le lecteur l’utilisera via le proxy et tu resteras **sur le site RÉQ**.

Avantages :
- HTTPS + CORS corrects automatiquement
- Compatible mobile et PWA
- Tu n’es plus obligé d’aller sur le site officiel de la radio

Tu peux déployer ce proxy une seule fois et l’utiliser pour tout le projet. Il est très léger (le free tier de Cloudflare suffit largement).

---

### Comment contribuer à l’amélioration des flux

- Ajoute des flux directs que tu trouves dans `radios.json`
- Améliore le script `discover-streams.js` (plus de scrapers, plus d’heuristiques par station)
- Si tu trouves un bon proxy alternatif, ouvre une PR

L’objectif : que **le plus possible** de radios puissent s’écouter directement dans RÉQ sans jamais quitter le site.

---

## 📰 Fil d’actualités étudiantes (RSS) + bots

La section **Actualités** agrège les flux RSS de journaux étudiants québécois. Tout est
**statique et sans CORS** : un bot reconstruit `news.json` côté GitHub Actions, le site ne fait que le lire.

### Registre des sources — `news-sources.json`
- `active` : les flux validés, lus par `scripts/fetch-news.js`. Champs `_status` (`ok`/`stale`/`dead`),
  `_lastItemDate`, `_lastChecked`, `_failCount` **maintenus par le bot** (ne pas éditer à la main).
- `candidates` : journaux à surveiller (URL du site). Le bot les sonde et **promeut** automatiquement
  ceux qui exposent un flux RSS frais.

### Deux bots
1. **Agrégateur** — `scripts/fetch-news.js` (`.github/workflows/update-news.yml`, 3×/jour)
   - Lit les sources `active`, télécharge chaque flux, normalise (titre, lien, extrait, image, date), écrit `news.json`.
2. **Mainteneur & découvreur** — `scripts/discover-news-sources.js` (`.github/workflows/discover-news-sources.yml`, 1×/semaine)
   - Santé des flux actifs (joignables ? publient-ils encore ?) → met à jour `_status`.
   - Sonde les `candidates` (`/feed/`, `?feed=rss2`, etc.) et promeut les flux frais vers `active`.
   - Les flux marqués `dead` sont conservés (ils peuvent revivre à la rentrée) mais ignorés par l’agrégateur.

Lancer en local : `node scripts/discover-news-sources.js` (dry-run) puis `--update` pour écrire.

### Ajouter une source
Ajoute une entrée dans `candidates` de `news-sources.json` (`name`, `institution`, `region`, `type`,
`lang`, `site`). Au prochain passage, le bot la testera et la promouvra si le flux est valide et récent.

### Catalogue des établissements — `institutions.json`
Liste canonique des **établissements d'enseignement supérieur du Québec** (universités + cégeps) à
laquelle les bots se réfèrent.
- **Bot** `scripts/update-institutions.js` (`.github/workflows/update-institutions.yml`) — tourne
  **3×/an** (5 janvier / 5 mai / 5 septembre, aligné sur les sessions).
  - **Cégeps** : tirés en direct de **Wikidata** (instances de CEGEP `Q1110056`) → fusions, nouveaux
    campus et sites renommés sont captés automatiquement.
  - **Universités** : liste curée stable (l'ensemble québécois ne change pratiquement jamais).
  - Résilient : si Wikidata est injoignable, le fichier existant est conservé (jamais écrasé à vide).
- Le bot de découverte croise ce catalogue pour **rapporter les trous de couverture** (établissements
  sans source de nouvelles), ce qui guide l'ajout de nouveaux `candidates`.

Lancer en local : `node scripts/update-institutions.js` (dry-run) puis `--update`.

---

## 🎨 Identité visuelle RÉQ

**Palette**
- `--accent`: #6366f1 (Indigo principal)
- `--accent-2`: #14b8a6 (Teal secondaire – fraîcheur québécoise)
- Fond: #070707 / #0a0a0b
- Texte: blanc / gris doux

**Typographie**
- Titres : Sora (bold, tracking serré)
- Corps : Space Grotesk (moderne, lisible)

**Logo principal**
- Icône carrée + wordmark dans `assets/logos/req-icon.jpg`
- Utilisé dans le header et PWA

**Logos stations**
- Style unifié généré par IA (carrés, minimalistes, ondes radio subtiles)
- Quelques logos officiels Wikimedia intégrés (ex: CISM)
- Fallback : badges lettrés colorés

Les assets sont dans `assets/logos/`.

### Guidelines courtes
- Toujours utiliser les logos fournis pour cohérence.
- Préférer les images réelles aux badges quand disponibles.
- L'accent-2 peut être utilisé pour les éléments secondaires (boutons, highlights).
- Garder le contraste élevé pour accessibilité mobile.

## 🛠️ Stack technique

- HTML5 + CSS + Vanilla JS (ES modules)
- Tailwind CSS via CDN (pour rester 100% statique)
- Service Worker + Web App Manifest → PWA installable
- `new Audio()` + Media Session API pour la lecture en arrière-plan

Aucun build step, aucun framework lourd.

---

## 🤝 Contribuer

Les contributions sont les bienvenues !

1. Fork le projet
2. Crée une branche (`git checkout -b ajout-radio-cegep-x`)
3. Ajoute/modifie des entrées dans `radios.json`
4. Teste localement
5. Ouvre une Pull Request

Tu peux aussi :
- Signaler des liens cassés ou des infos périmées
- Proposer des améliorations d’UX / accessibilité
- Ajouter de nouvelles stations (surtout des cégeps !)

---

## 📄 Licence

MIT — voir le fichier [LICENSE](LICENSE).

---

**Merci à toutes les radios étudiantes qui font vibrer les campus du Québec !** 🎧📻

*Projet créé et maintenu par la communauté.*