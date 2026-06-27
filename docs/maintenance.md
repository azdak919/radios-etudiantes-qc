# LE RADAR — Maintenance automatisée à long terme

Ce document décrit comment le projet se maintient **sans intervention humaine**
dans l'idéal, et ce qui reste volontairement manuel.

---

## Philosophie

1. **Données en JSON, pas de base de données** — tout est versionné dans Git.
2. **Bots idempotents** — un run raté ne corrompt rien ; le prochain reprend.
3. **Découverte progressive** — les nouveaux médias passent par `candidates` avant d'être promus.
4. **Rapport de santé** — `bot-status.json` résume l'état après chaque maintenance hebdomadaire.
5. **Alerte humaine rare** — une issue GitHub s'ouvre seulement si le pipeline échoue ou que plusieurs flux meurent.

---

## Fichiers sources de vérité

| Fichier | Rôle | Qui le met à jour |
|---|---|---|
| `institutions.json` | Catalogue cégeps + universités (Wikidata + liste curée) | `update-institutions.js` |
| `news-sources.json` | Registre des journaux (`active` + `candidates`) | `discover-news-sources.js`, `scan-media.js` |
| `news.json` | Fil d'articles agrégé (lu par le site) | `fetch-news.js` |
| `radios.json` | Radios listées dans le syntoniseur | humain + `discover-streams.js` |
| `radios-candidates.json` | Radios à tester avant promotion | `scan-media.js`, `discover-streams.js` |
| `radio-schedules.seed.json` | Config sources + grilles manuelles | humain + `discover-schedule-sources.js` |
| `radio-schedules.json` | Grilles colligées « à l'antenne » (lu par le site) | `fetch-radio-schedules.js` |
| `radio-nowplaying.json` | Titre en ondes via métadonnées ICY (lu par le site) | `fetch-radio-nowplaying.js` |
| `bot-status.json` | Tableau de bord santé des bots | `maintain.js` |

---

## Pipeline (ordre d'exécution)

```
institutions  →  scan-media  →  news-sources  →  streams  →  news  →  bot-status
```

| Étape | Script | Fréquence |
|---|---|---|
| Institutions | `update-institutions.js` | 3×/an (jan/mai/sep) + hebdo |
| Scanner de lacunes | `scan-media.js` | Hebdo |
| Santé + promotion journaux | `discover-news-sources.js` | Hebdo + quotidien via news |
| Flux radio + promotion candidats | `discover-streams.js` | Quotidien + hebdo |
| Agrégation articles | `fetch-news.js` | 7×/jour |
| Extrait « à la une » | `enrich-lead-excerpts.js` | 7×/jour (après `fetch-news`) |
| Titre en ondes (ICY) | `fetch-radio-nowplaying.js` | Aux 30 min |
| Découverte sources horaires | `discover-schedule-sources.js` | **Aux 2 semaines** (avant les horaires) |
| Horaires « à l'antenne » | `fetch-radio-schedules.js` | **Aux 2 semaines** |
| **Orchestrateur** | `maintain.js` | **Hebdo (lundi)** |

### Workflows GitHub Actions

- `maintain.yml` — pipeline complet + `bot-status.json` + issue si besoin
- `update-news.yml` — articles frais (haute fréquence)
- `update-streams.yml` — validation des flux (quotidien)
- `update-radio-nowplaying.yml` — titre en ondes via ICY (aux 30 min)
- `update-radio-schedules.yml` — horaires colligés « à l'antenne » (aux 2 semaines)
- `discover-news-sources.yml` — santé des flux RSS (hebdo)
- `update-institutions.yml` — catalogue établissements (3×/an)

Les workflows quotidiens restent pour la fraîcheur ; `maintain.yml` fait la passe
« long terme » (découverte de nouveaux médias, couverture, rapport).

---

## Découverte automatique

### Journaux étudiants

1. `scan-media.js` parcourt les établissements **sans source** dans `institutions.json`.
2. Il cherche des liens « journal / média étudiant » et sonde les flux RSS (`/feed/`, etc.).
3. Les trouvailles vont dans `news-sources.json` → `candidates`.
4. `discover-news-sources.js` promeut les candidats avec un flux **frais** (< 1 an) vers `active`.
5. `fetch-news.js` agrège les `active` vers `news.json`.

### Radios

1. `scan-media.js` repère des liens « radio / FM / écoute » sur les sites d'établissements.
2. Les candidats vont dans `radios-candidates.json`.
3. `discover-streams.js` teste chaque candidat (Icecast, Airtime, scraping).
4. Si un flux **HTTPS valide** est trouvé → promotion automatique vers `radios.json`.

La promotion radio est conservative : pas de flux = le candidat reste en file d'attente.

---

## Protocole : ajouter un journal au fil de Le Radar

**Guide détaillé (humains et bots)** : [`docs/adding-news-source.md`](adding-news-source.md)
— éligibilité, découverte RSS vs `html-list`, champs du registre, checklist complète.

Un établissement peut avoir **plusieurs journaux indépendants** (ex. Concordia :
**The Link** et **The Concordian** — deux rédactions, deux flux, deux filtres).
Seuls les **médias étudiants** sont éligibles (pas les portails institutionnels).

### Checklist d'intégration

| Étape | Fichier / commande | Obligatoire |
|-------|-------------------|-------------|
| 1. Registre | `news-sources.json` → `active` : `name`, `institution`, `region`, `type`, `lang`, `url`, `popularity` | oui |
| 2. Site public | champ `site` (réseaux sociaux, découverte) | recommandé |
| 3. Vérification | `node scripts/verify-news-sources.js --name "<journal>"` | oui |
| 4. Agrégation | `node scripts/fetch-news.js --update` | oui |
| 5. Extrait vedette | `node scripts/enrich-lead-excerpts.js --update` | oui (articles `featured` + récents) |
| 6. Images vedette | `node scripts/ensure-lead-images.js --update` | oui (crédits source vérifiés sur la page) |
| 7. Réseaux sociaux | `node scripts/fetch-social.js --update` | optionnel |
| 8. Cache PWA | incrémenter `CACHE_NAME` dans `sw.js` | oui si `app.js` touché |
| 9. Déploiement | `git commit` + `git push` | oui |

### Raccourci script

```bash
node scripts/add-news-source.js \
  --name "The Concordian" \
  --institution "Concordia University" \
  --region "Montréal" --type universite --lang en \
  --url "https://theconcordian.substack.com/feed" \
  --site "https://theconcordian.com/" \
  --popularity 7 \
  --note "Journal indépendant, distinct de The Link" \
  --promote --update
```

### Ce qui est automatique (rien à coder)

- **Filtres UI** : générés depuis `news.json` + métadonnées `news-sources.json`
- **Couleurs** : `brand-colors.json` par **institution** (deux journaux Concordia → même palette)
- **Vue source** : filtre par `name` (chaque journal a sa propre vue magazine)
- **Bots CI** : `discover-news-sources`, `fetch-news`, `enrich-lead-excerpts`, `ensure-lead-images` lisent le registre
- **Texte à la une** : `leadExcerpt` = paragraphe jugé adapté (score : longueur, phrases complètes, ton journalistique ; rejette chapôs, meta éditoriale, navigation). Pas l'extrait RSS tronqué.

### Cas particuliers

- **Site derrière Cloudflare** (ex. The Concordian) : mettre l’URL officielle dans `url`
  (`https://theconcordian.com/feed/`) et un repli dans `urlFallback` si le bot reçoit HTTP 403.
  Le repli Substack alimente le fil mais ce sont surtout newsletters/podcasts — pas l’équivalent
  complet du site. Si Concordia whitelist le bot, le flux principal prendra le relais automatiquement.
- **Auteur générique** : ajouter le nom du journal dans `GENERIC_AUTHORS` (`fetch-news.js`) si le RSS signe « The Concordian » au lieu d'un humain
- **WordPress vedettes** : champ optionnel `wpFeaturedCategories` (ex. Le Délit → `slider`)
- **Sans flux RSS** (média étudiant) : `fetchMode: "html-list"` + `url` = page de liste.
  Voir `scripts/html-list-fetcher.js`.

---

## Ce qui reste manuel (volontairement)

- **Logos et identité** des nouvelles radios promues automatiquement
- **Proxy Cloudflare** (`PROXY_BASE` dans `app.js`) pour les flux HTTP
- **Candidats de qualité** : ajouter un `site` connu dans `news-sources.json` accélère la découverte
- **Faux positifs** : retirer une entrée `candidates` si le bot se trompe

---

## Commandes utiles

```bash
# Pipeline complet (dry-run)
node scripts/maintain.js

# Pipeline complet + écriture
node scripts/maintain.js --update

# Sans rafraîchir institutions (plus rapide)
node scripts/maintain.js --update --skip-institutions

# Étape individuelle
node scripts/scan-media.js --update
node scripts/discover-news-sources.js --update
node scripts/discover-streams.js --update
node scripts/fetch-news.js --update
node scripts/enrich-lead-excerpts.js --update
```

---

## Horaires « à l'antenne »

Le bandeau **À l'antenne** affiche l'émission en cours selon l'heure (fuseau
`America/Toronto`), en complément du titre ICY live. La grille est colligée de
deux façons, fusionnées par `fetch-radio-schedules.js` :

1. **Sources dynamiques** déclarées dans `radio-schedules.seed.json`
   (`sources`), via les adaptateurs de `radio-schedule-lib.js` :

   | `type` | Source | Postes |
   |---|---|---|
   | `airtime` | API Airtime/LibreTime `/api/week-info` | CKUT |
   | `chyz` | HTML `chyz.ca/horaire` (thème maison) | CHYZ |
   | `cfak` | HTML `cfak.ca/programmation` (cartes par jour) | CFAK |
   | `jsonld` | Données structurées schema.org (`BroadcastEvent`/`Event`) | générique |
   | `spinitron` | API Spinitron `/api/shows` (jeton requis) | générique |

   Pour brancher un nouveau poste : ajouter un adaptateur (ou réutiliser
   `jsonld`/`spinitron`), puis le déclarer dans `ADAPTERS`.
2. **Grilles manuelles** : remplir le tableau `grid` du poste dans le seed.

### Découverte automatique des sources

`discover-schedule-sources.js` automatise la recherche et l'entretien des
sources. Pour chaque poste, il :

- **revalide** les sources déjà déclarées (et retire celles qui ne répondent plus) ;
- **sonde** des sources potentielles : Airtime déduit du flux, JSON-LD et
  adaptateur dédié testés sur les chemins d'horaire usuels (`/horaire/`,
  `/grille-horaire/`, `/programmation/`, `/schedule/`, …) ;
- **détecte** les plateformes connues (Spinitron) à brancher manuellement ;
- **rapporte** la santé : sources trouvées, perdues, postes sans horaire.

Avec `--update`, il réécrit les `sources` du seed (grilles manuelles et notes
préservées). Il tourne en CI juste **avant** `fetch-radio-schedules.js`.

```jsonc
// radio-schedules.seed.json
"chyz": {
  "sources": [],
  "grid": [
    { "day": 1, "start": "07:00", "end": "09:00", "title": "Le Réveil", "host": "…" }
  ]
}
```

- `day` : 0 = dimanche … 6 = samedi.
- `start`/`end` : `"HH:MM"` 24 h ; une fin ≤ au début traverse minuit.
- Si toutes les sources sont injoignables un cycle, la dernière grille connue
  de `radio-schedules.json` est conservée.

Régénérer : `node scripts/fetch-radio-schedules.js --update`. En CI, le workflow
`update-radio-schedules.yml` tourne **aux 2 semaines** (les horaires bougent
rarement, inutile de solliciter les sources plus souvent).

---

## Reprise après une longue pause

Si personne ne touche au repo pendant des mois :

1. Les **Actions planifiées** reprennent au prochain cron (gratuit sur GitHub public).
2. Les flux `dead` sont **conservés** (rentrée scolaire) mais ignorés par l'agrégateur.
3. `scan-media.js` rattrape les **établissements non couverts** par lots de 8/semaine.
4. `bot-status.json` indique les lacunes et alertes.

Aucune dépendance externe payante. Node 20 + `https` natif seulement.

---

## Règle d'or

> **Les humains curatent la qualité ; les bots curatent la fraîcheur et la couverture.**