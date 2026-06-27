# Ajouter une source au fil de Le Radar

Guide pour intégrer un **média étudiant** (journal de campus, média
indépendant tenu par des étudiant·e·s) au fil **Le fil étudiant**. Destiné aux
humains et aux bots (`discover-news-sources.js`, agents CI).

Voir aussi `docs/maintenance.md` pour le pipeline global.

---

## 1. Éligibilité

| Critère | Attendu |
|---------|---------|
| Périmètre | Québec — universités et cégeps |
| Nature | **Média étudiant** : rédaction étudiante indépendante ou journal de campus |
| Langue | `fr` ou `en` (filtre UI) |
| Fraîcheur | Publications récentes (le fil global plafonne à ~3 sessions universitaires) |
| Indépendance | Plusieurs journaux par établissement sont acceptés s'ils sont distincts (ex. The Link + The Concordian) |

**Exclus** : portails de communications institutionnelles (ex. `nouvelles.ulaval.ca`),
sites d'actualités officielles des universités, communiqués de presse administratifs.

**Exemple ULaval** : seul `L'Exemplaire` (journal étudiant indépendant) est éligible.

---

## 2. Découvrir le flux

### 2.1 RSS / Atom (cas le plus courant)

Tester dans l'ordre :

```
/feed/
/feed
/rss/
/rss
/atom.xml
?feed=rss2
```

Le bot `discover-news-sources.js` essaie ces chemins automatiquement sur les
`candidates` qui ont un champ `site`.

### 2.2 Pas de RSS (SvelteKit, headless CMS, etc.)

Si aucun flux n'existe sur un **média étudiant** (site SvelteKit, headless CMS, etc.),
utiliser **`fetchMode: "html-list"`** :

1. Trouver une **page de liste** avec articles récents en HTML SSR
   (souvent `/toutes-les-nouvelles`, `/nouvelles`, `/blog`, page d'accueil).
2. Vérifier que le HTML contient des liens datés (`/2026/06/26/slug-uuid`) ou des
   blocs `<article>` avec titre, extrait, image.
3. Mettre l'URL de cette page dans `url` (pas le site racine seul).

Parser partagé : `scripts/html-list-fetcher.js` (SvelteKit `HTML_TAG_START`, liens
datés en repli).

### 2.3 SPA + Firebase Firestore (pas de RSS)

Si le site est une **SPA** (React, etc.) dont les articles sont servis depuis
**Firestore** public (ex. **Le Polyscope**), utiliser **`fetchMode: "firebase"`** :

1. Inspecter le bundle JS client pour `projectId`, `apiKey`, nom de collection.
2. Vérifier les champs document : titre, date, auteur, image, flag `publish`.
3. Renseigner le bloc `firebase` dans `news-sources.json` :

```json
{
  "fetchMode": "firebase",
  "firebase": {
    "projectId": "polyscope-6feba",
    "apiKey": "…",
    "collection": "blogs",
    "publishField": "publish",
    "dateField": "publishedDate",
    "linkTemplate": "/blog/post/{uid}"
  }
}
```

Parser partagé : `scripts/firebase-list-fetcher.js`.

Pour les **réseaux sociaux** : les SPA ne servent souvent qu'un shell HTML vide.
Ajouter des champs `instagram`, `facebook`, `x` dans `news-sources.json` (comme
`radios.json`) — `fetch-social.js` les utilise en preset.

### 2.4 Cloudflare / site bloqué

Comme **The Concordian** : `url` = flux WordPress officiel, `urlFallback` = repli
(Substack, autre). Documenter la limite du repli dans `_note`.

---

## 3. Registre `news-sources.json`

### Champs obligatoires (`active`)

| Champ | Description |
|-------|-------------|
| `name` | Nom affiché dans les filtres UI (unique) |
| `institution` | Doit correspondre à `institutions.json` |
| `region` | Région administrative |
| `type` | `universite` ou `cegep` |
| `lang` | `fr` ou `en` |
| `url` | Flux RSS **ou** page liste HTML si `fetchMode: html-list` |
| `popularity` | Ordre des filtres (1 = en tête) |

### Champs recommandés

| Champ | Description |
|-------|-------------|
| `site` | Site public (réseaux sociaux, découverte par bots) |
| `_note` | Contexte interne (distinction d'autres journaux, limites du repli) |
| `urlFallback` | URL de repli si le principal échoue |
| `fetchMode` | `rss` (défaut), `html-list` ou `firebase` |
| `firebase` | Config Firestore si `fetchMode: firebase` |
| `instagram`, `facebook`, `x` | Réseaux sociaux (preset si SPA sans liens HTML) |
| `wpFeaturedCategories` | Catégories WordPress pour vedettes hors flux (ex. Le Délit → `slider`) |

### Champs bots (automatiques)

`_status`, `_lastItemDate`, `_lastChecked`, `_failCount`, `_lastFetchOk` —
mis à jour par `discover-news-sources.js` et `fetch-news.js`.

### Instructions par bot (`botHints`)

Quand un journal a des particularités (Cloudflare, TagDiv, SPA, etc.), documenter
les consignes dans `botHints` plutôt que d'éparpiller la logique dans le code :

```json
"botHints": {
  "fetch": { "preferFallbackOn403": true },
  "authors": { "selectors": ["post-author", "td-post-author-name"] },
  "images": { "rejectPathPatterns": ["lapige_web"], "preferSizeFull": true },
  "excerpts": {},
  "credits": {}
}
```

Lecture : `getBotHints(src, 'authors')` dans `scripts/source-retention-lib.js`.
Les bots spécialisés (`author-lib.js`, `article-image-lib.js`, etc.) peuvent s'y
brancher progressivement.

### Rétention des sources (flux RSS peu fiables)

`fetch-news.js` **ne retire plus une source** lorsqu'un flux échoue une fois.
Il conserve les articles **encore dans la fenêtre de fraîcheur UI** (3 sessions
universitaires), marqués `_retainedFromCache: true` dans `news.json`.

Une source n'est retirée que si, après 3 sessions, **aucun article frais** n'est
obtenu ni en cache ni via le flux. Voir `scripts/source-retention-lib.js`.

### Candidats (`candidates`)

Entrée minimale quand le flux n'est pas encore trouvé :

```json
{
  "name": "Nom du journal",
  "institution": "Université X",
  "region": "Montréal",
  "type": "universite",
  "lang": "fr",
  "site": "https://exemple.ca/"
}
```

Le bot sonde `site` + chemins RSS ; promotion auto si flux frais (< 1 an).

---

## 4. Commande rapide

```bash
cd radios-etudiantes-qc

# Cas RSS classique
node scripts/add-news-source.js \
  --name "The Concordian" \
  --institution "Concordia University" \
  --region "Montréal" --type universite --lang en \
  --url "https://theconcordian.com/feed/" \
  --site "https://theconcordian.com/" \
  --popularity 7 \
  --note "Journal indépendant, distinct de The Link" \
  --update

# Cas sans RSS (page liste HTML — média étudiant seulement)
node scripts/add-news-source.js \
  --name "Exemple Journal" \
  --institution "Université X" \
  --region "Montréal" --type universite --lang fr \
  --url "https://journal-etudiant.example.ca/nouvelles" \
  --site "https://journal-etudiant.example.ca/" \
  --fetchMode html-list \
  --popularity 50 \
  --note "Journal étudiant sans flux RSS" \
  --update
```

---

## 5. Pipeline après ajout

| # | Commande | Rôle |
|---|----------|------|
| 1 | `node scripts/verify-news-sources.js --name "<journal>"` | Champs, flux/liste, articles dans `news.json` |
| 2 | `node scripts/fetch-news.js --update` | Reconstruit `news.json` |
| 3 | `node scripts/verify-authors.js --update` | QC auteurs (optionnel mais recommandé) |
| 4 | `node scripts/ensure-lead-images.js --update` | Images vedette |
| 5 | `node scripts/fetch-social.js --update` | Réseaux sociaux (si `site` renseigné) |
| 6 | Incrémenter `CACHE_NAME` dans `sw.js` | Si `app.js` / assets modifiés |
| 7 | `git commit` + `git push` | Déploiement GitHub Pages |

Raccourci : `node scripts/maintain.js --update`

---

## 6. Ajustements manuels possibles

| Problème | Fichier / action |
|----------|------------------|
| Auteur générique (« The Concordian », nom du journal) | `GENERIC_AUTHORS` dans `scripts/fetch-news.js` |
| Vedettes WordPress absentes du RSS | `wpFeaturedCategories` (ex. `["slider"]` pour Le Délit uniquement — pas de défaut global) |
| Auteurs incorrects en masse | `botHints.authors` dans `news-sources.json`, puis `verify-authors.js` |
| Flux qui disparaît après un run CI | Automatique : cache 3 sessions via `source-retention-lib.js` |
| Images vedette faibles | `scripts/stock-photo-lib.js`, `ensure-lead-images.js` |
| Nouveau parseur HTML (autre CMS) | Étendre `scripts/html-list-fetcher.js` ou ajouter un `fetchMode` |

---

## 7. Checklist bot (découverte automatique)

Quand un bot trouve un candidat :

1. Confirmer que c'est un **média étudiant** (pas un portail institutionnel)
2. Confirmer l'établissement dans `institutions.json`
3. Vérifier qu'aucune source active ne porte déjà le même `name` ou `url`
4. Sonder RSS sur `site` ; sinon chercher page liste HTML datée
5. Si RSS frais → promouvoir via `discover-news-sources.js --update`
6. Si HTML seulement → ajouter manuellement avec `fetchMode: html-list` (promotion auto RSS uniquement aujourd'hui)
7. Lancer le pipeline §5
8. Documenter le cas particulier dans `_note` si repli ou contenu partiel

---

## 8. Fichiers touchés (référence)

```
news-sources.json      # registre
news.json              # agrégat (généré)
institutions.json      # établissements
brand-colors.json      # couleurs par institution
social-feed.json       # réseaux (généré)
scripts/
  add-news-source.js       # CLI d'ajout
  verify-news-sources.js   # QC intégration
  fetch-news.js            # agrégation RSS + html-list + firebase
  html-list-fetcher.js     # parseur pages liste
  firebase-list-fetcher.js # parseur Firestore REST
  discover-news-sources.js # santé + promotion candidates
  maintain.js              # orchestrateur
```