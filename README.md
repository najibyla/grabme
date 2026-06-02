# GrabMe — Extension Chrome de capture vidéo

Détecte et télécharge automatiquement les vidéos sur **Skool**, **Loom**, **YouTube**, **YouTube Shorts** et **Vimeo**.

---

## Fonctionnalités

- Détection automatique des flux vidéo (HLS/m3u8, embeds) sans aucune manipulation manuelle
- **Sélection de résolution** : voir toutes les qualités disponibles (1080p, 720p…) avant de télécharger
- **Progression en temps réel** : pourcentage ou timecode FFmpeg dans le popup
- **Téléchargement en arrière-plan** : le popup peut être fermé, une notification Chrome signale la fin
- **Tout télécharger** : démarre tous les téléchargements d'une playlist en un clic
- Nommage automatique des fichiers à partir du titre de la vidéo

---

## Plateformes supportées

| Plateforme | Détection | Outil de téléchargement |
|---|---|---|
| Skool (native HLS) | URL master.m3u8 interceptée | FFmpeg |
| Loom (embed dans Skool) | URL mediaplaylist-video interceptée | curl + FFmpeg |
| YouTube (direct ou embed) | Onglet `youtube.com/watch`, embed, ou iframe | yt-dlp |
| YouTube Shorts | Onglet `youtube.com/shorts/` | yt-dlp |
| Vimeo (embed) | URL vimeocdn.com interceptée, titre lu dans l'iframe | FFmpeg |

---

## Architecture

```
Page web (Skool / Loom / YouTube / Vimeo)
        │
        │  réseau HTTP (webRequest) + DOM (content script)
        ▼
background.js        ← service worker MV3
        │              intercepte m3u8, loom.com, youtube embeds, vimeocdn.com
        │              auto-détecte les onglets YouTube/Shorts
        │              stocke dans chrome.storage.local par tabId
        │              surveille les jobs via chrome.alarms (polling /status)
        │              envoie chrome.notifications quand terminé
        ▼
content.js           ← tourne sur toutes les pages ET dans l'iframe player.vimeo.com
        │              extrait le titre courant (document.title) et la playlist
        │              envoie vimeoFrameTitle / vimeoPlaylistTitles à background.js
        ▼
popup.js / popup.html ← affiche les streams détectés
        │               Copy URL / ⬇ Meilleure / ▾ Qualités / ⬇ Tout
        │
        │  POST http://127.0.0.1:5000/download   (url + title + format)
        │  GET  http://127.0.0.1:5000/qualities  (liste des résolutions)
        ▼
server.py (Flask)    ← pilote FFmpeg / yt-dlp dans un thread par job
        │              retourne job_id, stream la progression via SSE
        │              expose GET /status/:job_id pour le polling background
        ▼
~/Downloads/titre-de-la-video.mp4
```

---

## Prérequis

| Outil | Usage | Installation |
|---|---|---|
| Python 3.10+ | Serveur Flask | [python.org](https://python.org) |
| Flask + flask-cors | API locale | `pip install flask flask-cors` |
| FFmpeg 8.x | Conversion HLS → MP4 | `winget install ffmpeg` |
| curl | Téléchargement manifestes Loom | inclus dans Windows 10+ |
| yt-dlp | Téléchargement YouTube/Shorts | `pip install yt-dlp` |

---

## Installation

### 1. Extension Chrome

1. Ouvrir `chrome://extensions`
2. Activer le **Mode développeur** (en haut à droite)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner ce dossier

### 2. Serveur Python

```powershell
cd c:\utils\myM3uToMp4
python server.py
```

Le serveur écoute sur `http://127.0.0.1:5000`. Le laisser tourner pendant l'utilisation de l'extension.

---

## Utilisation

### Flux de base

1. Lancer `python server.py`
2. Naviguer vers une page contenant une vidéo
3. Lancer la lecture (quelques secondes suffisent)
4. Cliquer sur l'icône **GrabMe** dans Chrome
5. Les flux détectés apparaissent avec leur label coloré :
   - 🟣 **LOOM** — vidéo Loom embarquée
   - 🔴 **YOUTUBE / SHORT** — vidéo ou Short YouTube
   - 🔵 **VIMEO** — vidéo Vimeo avec titre de la vidéo courante
   - 🟡 **SKOOL NATIVE** — vidéo HLS native Skool

### Sélection de qualité

- **⬇ Meilleure** — télécharge directement la meilleure résolution disponible
- **▾ Qualités** — charge la liste des résolutions et affiche des boutons :
  - Skool / Vimeo : parse le master m3u8 → `[1080p] [720p] [480p]`
  - YouTube : `yt-dlp` → `[1080p] [720p] [480p] [360p]`
  - Loom : bitrates fixes → `[3200k HD] [1800k] [700k]`

### Playlist Vimeo (ex : Game Codeur)

1. Jouer chaque vidéo → son m3u8 est capturé et son titre lu dans l'iframe
2. Une fois plusieurs vidéos capturées, le bouton **⬇ Tout** apparaît
3. Cliquer **⬇ Tout** lance tous les téléchargements simultanément
4. Le popup peut être fermé — une notification Chrome apparaît pour chaque vidéo terminée

### YouTube direct

Naviguer sur `youtube.com/watch?v=...` ou `youtube.com/shorts/...` suffit — l'extension enregistre la vidéo automatiquement sans avoir besoin de la jouer.

---

## Description des fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Config extension Chrome MV3 — permissions, content scripts, service worker |
| `background.js` | Service worker : détection des streams, tracking des jobs, notifications |
| `content.js` | Script injecté dans toutes les pages **et** dans l'iframe `player.vimeo.com` — extrait les titres Vimeo |
| `popup.html` | Interface du popup (340 px) |
| `popup.js` | Logique popup : rendu des streams, sélection qualité, SSE progression, Download All |
| `server.py` | Serveur Flask : `/download`, `/qualities`, `/status/:id`, `/progress/:id` (SSE) |
| `grabme.sh` | Script CLI unifié (Skool / Loom / YouTube) pour Git Bash Windows |
| `grabme_loom.sh` | Script CLI Loom : reconstruction du manifeste m3u8 + FFmpeg |
| `grabme.bat` | Script CLI Skool pour Windows natif (cmd / PowerShell) |
| `native_host.py` | Alternative au serveur Flask via Native Messaging Chrome |
| `install_native_host.bat` | Enregistre le Native Messaging Host dans le registre Windows |
| `com.skool.grabme.json` | Manifeste du Native Messaging Host |

---

## Permissions Chrome

| Permission | Usage |
|---|---|
| `webRequest` | Intercepter les requêtes réseau pour détecter les m3u8 |
| `storage` | Stocker les streams détectés par onglet |
| `tabs` | Lire le titre de l'onglet courant, détecter la navigation YouTube |
| `notifications` | Notification de fin de téléchargement quand le popup est fermé |
| `alarms` | Polling toutes les 10 s du statut des jobs en arrière-plan |
| `host_permissions: <all_urls>` | Nécessaire pour intercepter toutes les requêtes (Skool, Loom, Vimeo, YouTube…) |
| `all_frames: true` | Injection du content script dans les iframes cross-origin (player.vimeo.com) |

---

## Scripts CLI (sans extension)

### Skool / générique

```bash
./grabme.sh "https://cdn.skool.com/.../master.m3u8" ma_video.mp4
```

### Loom

```bash
./grabme_loom.sh "https://luna.loom.com/.../mediaplaylist-video-bitrate3200.m3u8?Signature=..." video.mp4
```

### YouTube / Shorts

```bash
./grabme.sh "https://www.youtube.com/watch?v=VIDEO_ID" video.mp4
./grabme.sh "https://www.youtube.com/shorts/VIDEO_ID" short.mp4
```

---

## Historique des versions

| Version | Commit | Changements |
|---|---|---|
| 1.4 | `292d2a7` | Fix quality picker audio (Skool/Vimeo) ; YouTube/Shorts détection fiabilisée (webRequest main_frame) |
| 1.3.2 | `390d3f8` | Fix titre Vimeo "LocalStorage Proxy" ; fix Shorts MV3 (setTimeout → changeInfo.title) |
| 1.3 | `ff1dedd` | Sélection de résolution (endpoint `/qualities`), yt-dlp format selector, HLS master parsing |
| 1.2 | `e62c656` | Vimeo titles depuis iframe (`all_frames`), téléchargement arrière-plan (alarms + notifications), "Tout télécharger" |
| 1.1 | `62f20ba` | Détection YouTube direct, refresh titre Vimeo, branding GrabMe, badge couleur Vimeo |
| 1.0 | `151a211` | Version initiale — Skool, Loom, YouTube embed, Vimeo ; SSE progression ; protection double-clic |

### Correctifs notables

- **Quality picker sans audio (Skool/Vimeo)** (`292d2a7`) : `urllib.parse.urljoin` supprimait le query string CloudFront lors de la résolution des URLs relatives dans le master HLS → tokens d'auth perdus → 403 silencieux → video-only. Corrigé par préservation du query string + extraction de l'URL audio EXT-X-MEDIA incluse dans chaque quality option.
- **YouTube/Shorts non détectés** (`292d2a7`) : détection ajoutée dans le webRequest listener pour les requêtes `main_frame` (sécurité supplémentaire quand `tabs.onUpdated` ne fire pas pour la navigation SPA).
- **Vimeo sans audio** (`4f9184e`) : background.js capture l'URL `/sep/audio/` réelle et l'attache au stream vidéo (`audioUrl` field) ; run_vimeo utilise dual-input FFmpeg quand audioUrl est fourni.
- **Vimeo I-frame tracks** (`4f9184e`) : URLs contenant `iframe` filtrées (206 kbit/s, pas d'audio).
- **Vimeo titre "LocalStorage Proxy"** (`390d3f8`) : filtré dans `BAD_TITLES` (content.js et background.js).
- **VLC ouvre 3 fenêtres** (`ac38d50`) : `-map 0:V` copiait les I-frame tracks HLS → corrigé en `-map 0:v:0`.
- **Loom "Audio Seul"** (v1.0) : URL vidéo dérivée depuis l'URL audio quand la vidéo est en cache navigateur.
- **WinError 2 YouTube accents** (v1.0) : téléchargement vers chemin UUID temporaire + `shutil.move`.
- **Skool WebVTT** (v1.0) : `-map 0:v:0` exclut les sous-titres WebVTT incompatibles avec MP4.

---

## Publication Chrome Web Store

### Ce qui fonctionne ✅

- Manifest V3
- Permissions déclarées
- Fonctionnalité claire et ciblée

### Ce qui bloque ❌

| Problème | Solution |
|---|---|
| Dépendance serveur Python local | Passer au mode Native Messaging (lancé automatiquement par Chrome) |
| `host_permissions: <all_urls>` | Restreindre aux domaines : `*.skool.com`, `*.loom.com`, `*.youtube.com`, `*.vimeocdn.com` |
| Pas de Privacy Policy | Créer une page web dédiée |
| Icônes incomplètes | Ajouter 16×16, 48×48, 128×128 dans manifest.json |
| Pas de screenshots | Capturer le popup en action |

### Chemin vers la publication

```
1. Implémenter Native Messaging comme mode principal (plus de Flask manuel)
2. Créer un installateur Windows (MSI/NSIS) : Python + FFmpeg + yt-dlp + registry
3. Restreindre host_permissions aux domaines nécessaires
4. Privacy Policy + icônes + screenshots
5. Compte développeur Chrome Web Store (5$ unique)
6. Soumission (délai review : 1-7 jours)
```
