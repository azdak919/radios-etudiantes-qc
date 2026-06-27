# RADAR — Maintenance automatisée à long terme

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
| **Orchestrateur** | `maintain.js` | **Hebdo (lundi)** |

### Workflows GitHub Actions

- `maintain.yml` — pipeline complet + `bot-status.json` + issue si besoin
- `update-news.yml` — articles frais (haute fréquence)
- `update-streams.yml` — validation des flux (quotidien)
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
```

---

## Reprise après une longue pause

Si personne ne touche au repo pendant des mois :

1. Les **Actions planifiées** reprennent au prochain cron (gratuit sur GitHub public).
2. Les flux `dead` sont **conservés** (rentrée scolaire) mais ignorés par l'agrégateur.
3. `scan-media.js` rattrape les **établissements non couverts** par lots de 24/semaine.
4. `bot-status.json` indique les lacunes et alertes.

Aucune dépendance externe payante. Node 20 + `https` natif seulement.

---

## Règle d'or

> **Les humains curatent la qualité ; les bots curatent la fraîcheur et la couverture.**