# LE RADAR — Identité visuelle

Document de référence pour la marque **LE RADAR**. Source de vérité des couleurs :
les variables CSS dans [`style.css`](../style.css) (`:root` et `[data-theme="dark"]`).
Garder ce document et le code synchronisés.

---

## 1. Marque

| | |
|---|---|
| **Nom** | LE RADAR |
| **Forme courante** | Le Radar (texte courant, pastille « toutes les sources ») |
| **Slogan (FR)** | Les journaux et les radios étudiantes du Québec, réunis au même endroit |
| **Slogan (EN)** | Student media on your radar |
| **Nature** | Agrégateur des **radios** et **journaux étudiants** des cégeps et universités du Québec |
| **Ton** | Indépendant, jeune, éditorial. Français québécois, ouvert au bilingue (sources FR + EN). |

**Pourquoi « LE RADAR » :** nom bilingue (identique FR/EN), évoque « être sur le radar »
(découvrir, ne rien manquer) et l'héritage radio (RAdio Detection And Ranging).

---

## 2. Couleurs

Système **sémantique** : chaque couleur a un rôle, pas seulement une esthétique.

### Couleurs de marque

| Rôle | Nom | Hex | Usage |
|---|---|---|---|
| **Marque / éditorial** | Pourpre LE RADAR | `#6C2163` | Logo, « À la une », liens, survol des titres, accents éditoriaux. C'est le **mélange 50/50 du bleu du Québec et du rouge du Canada**. |
| **En direct / live** | Rouge diffusion | `#C8102E` | *Uniquement* le sémantique « en ondes » : bouton Écouter, indicateur EN ONDES, égaliseur, pastille « frais » (article récent). |
| **Volet radio** | Bleu officiel du Québec | `#003DA5` | Titrage et contrôles du syntoniseur (nom du poste, volume). Pantone 293. Version éclaircie `#5D9BE0` sur le bandeau sombre. |

> Le **pourpre est la fusion** des deux couleurs nationales (bleu QC `#003DA5` + rouge
> Canada `#D80621` → `#6C2163`). Le logo incarne cette fusion ; le site décline ensuite
> les couleurs sources par rôle (bleu = radio, rouge = live).

### Variantes (survol / mode sombre)

| Token CSS | Clair | Sombre |
|---|---|---|
| `--accent` (pourpre) | `#6C2163` | `#CF7EC1` (éclairci pour la lisibilité sur fond sombre) |
| `--accent-dark` | `#4F1749` | `#B85FA8` |
| `--live` / `--live-dark` | `#C8102E` / `#9C0C24` | identiques |
| `--radio` | `#003DA5` | identique |
| `--radio-bright` | `#5D9BE0` | identique |

### Neutres

| Token | Clair | Sombre | Usage |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0E0F12` | Fond de page |
| `--bg-soft` | `#F6F6F4` | `#181A1E` | Squelettes de chargement |
| `--ink` | `#16181C` | `#F1F2F4` | Texte principal |
| `--ink-soft` | `#44474D` | `#C2C6CD` | Texte secondaire / brèves |
| `--muted` | `#80858C` | `#888D96` | Métadonnées, dates |
| `--rule` | `#E7E7E3` | `#26282D` | Filets fins |
| `--rule-strong` | `#14161A` | `#F1F2F4` | Filets forts (titres de section) |
| `--tuner-bg` | `#111317` | `#1A1C21` | Bandeau du syntoniseur (toujours sombre) |

### Couleurs des sources (établissements)

Les pastilles et accents au survol des articles utilisent la **couleur officielle de
l'établissement** d'origine (université ou cégep), pas une palette arbitraire.
Source de vérité : [`brand-colors.json`](../brand-colors.json).

| Établissement | Couleur | Référence |
|---|---|---|
| Université de Montréal | `#0057AC` | Guide de marque UdeM |
| UQAM | `#0079BE` | Site institutionnel |
| McGill | `#ED1B2F` | Guide d'identité visuelle |
| Concordia | `#912338` | Site institutionnel |
| Université Laval | `#E30513` | Site institutionnel |
| Université de Sherbrooke | `#006B3F` | Identité visuelle UdeS |
| UQTR | `#00CB88` | Site institutionnel |
| Cégep du Vieux Montréal | `#CF1F1F` | Site institutionnel |
| Cégep de Jonquière | `#FF8B00` | Site institutionnel |

---

## 3. Typographie

| Rôle | Police | Graisses | Usage |
|---|---|---|---|
| **Titrage / serif** | **Source Serif 4** | 400 / 600 / 700 | Logo, titres d'articles, manchette, nom de poste, titres de section |
| **Texte / sans** | **Inter** | 400 / 500 / 600 / 700 | Corps, brèves, métadonnées, boutons, étiquettes |

Chargées via Google Fonts. Tokens : `--serif`, `--sans`.
Manchette « À la une » : `clamp(2rem, 6vw, 2.9rem)`. Eyebrows / étiquettes : majuscules,
`letter-spacing` large.

---

## 4. Logo / icône

**Concept :** une **fleur de lys** blanche au centre d'un **écran radar** (anneaux + croix),
sur tuile **pourpre `#6C2163`**. Réunit l'identité québécoise (fleur de lys), le nom de la
marque (radar) et la fusion des couleurs nationales (le pourpre).

- Fichier vectoriel maître : [`assets/icon.svg`](../assets/icon.svg) (1024×1024, coins arrondis `rx=232`)
- PNG d'app : `assets/icon-192.png`, `assets/icon-512.png` (plein-cadre, compatibles *maskable*)
- Le motif (fleur de lys + anneaux) tient dans ~70 % central → sûr pour le masquage Android.
- Mot-symbole : **LE RADAR** en Source Serif 4, 700, lettres capitales.

**À faire / à éviter**
- ✅ Fleur de lys blanche sur pourpre ; conserver l'air autour du motif.
- ✅ Sur fond clair, le mot-symbole peut être en `--ink` ; le pictogramme garde sa tuile.
- ❌ Ne pas recolorer la fleur de lys ni étirer le pictogramme.
- ❌ Ne pas utiliser le rouge « live » comme couleur de fond du logo.

---

## 5. PWA

- `manifest.json` : `name` = « LE RADAR — Les médias étudiants du Québec », `short_name` = « LE RADAR ».
- `theme_color` / `background_color` : `#FFFFFF`.
- Service worker : cache nommé `radar-shell-vN` — **incrémenter `N`** à chaque modification
  du shell (HTML/CSS/JS/icônes) pour pousser la mise à jour aux apps installées.

---

## 6. Règle d'or

**Pourpre = qui nous sommes. Rouge = c'est en direct. Bleu = c'est la radio.**
Rester sobre : une couleur par rôle, beaucoup de blanc, la typographie fait le travail.