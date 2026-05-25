# GrabMe — Extension Chrome de capture vidéo (Skool / Loom / YouTube)

## Présentation

Extension Chrome qui détecte automatiquement les flux vidéo chargés sur une page web (HLS/m3u8, MP4, embed YouTube) et offre deux actions :

- **Copy URL** — copie l'URL brute dans le presse-papiers (pour utilisation manuelle avec les scripts `.sh`/`.bat`)
- **Download** — déclenche le téléchargement complet via un serveur Python local, avec progression en temps réel

Plateformes supportées : **Skool.com** (vidéos natives), **Loom** (vidéos embed), **YouTube** (vidéos embed dans Skool).

---

## Architecture du pipeline

```
Page web (Skool/Loom/YouTube)
        │
        │  réseau HTTP
        ▼
background.js        ← intercepte toutes les requêtes réseau (webRequest API)
        │              détecte m3u8, loom.com, youtube.com/embed/
        │              stocke dans chrome.storage.local (par tabId)
        ▼
popup.js / popup.html ← affiche les streams détectés dans le popup
        │               boutons Copy URL et Download
        │
        │  POST http://127.0.0.1:5000/download
        ▼
server.py (Flask)    ← reçoit l'URL + titre de la page
        │               lance le téléchargement dans un thread
        │               retourne un job_id
        │
        │  GET http://127.0.0.1:5000/progress/{job_id}  (SSE)
        ▼
popup.js             ← reçoit la progression en temps réel (⏳ 47%... ✅ fichier.mp4)
        │
        ▼
~/Downloads/fichier.mp4
```

---

## Prérequis

| Outil | Usage | Installation |
|---|---|---|
| Python 3.10+ | Serveur Flask | python.org |
| Flask + flask-cors | Serveur HTTP local | `pip install flask flask-cors` |
| FFmpeg 8.x | Conversion HLS → MP4 | gyan.dev/ffmpeg ou `winget install ffmpeg` |
| curl | Téléchargement manifestes Loom | inclus dans Windows 10+ |
| yt-dlp | Téléchargement YouTube | `pip install yt-dlp` |

---

## Installation

### 1. Extension Chrome

1. Ouvrir `chrome://extensions`
2. Activer le **Mode développeur** (en haut à droite)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner le dossier `c:\utils\myM3uToMp4`

### 2. Serveur Python (mode Flask — recommandé)

```bash
cd c:\utils\myM3uToMp4
python server.py
```

Le serveur écoute sur `http://127.0.0.1:5000`. Le laisser tourner pendant l'utilisation.

### 3. (Optionnel) Mode Native Messaging — sans serveur

Voir section dédiée plus bas.

---

## Utilisation

1. Lancer `python server.py`
2. Naviguer vers une page Skool contenant une vidéo
3. Lancer la lecture (la vidéo doit charger au moins quelques secondes)
4. Cliquer sur l'icône de l'extension
5. Les flux détectés apparaissent dans le popup
6. Cliquer **Download** → progression en temps réel → fichier dans `~/Downloads`

---

## Scripts manuels (sans extension)

### Skool / générique

```bash
# Git Bash (Windows)
./grabme.sh "https://cdn.skool.com/.../master.m3u8" ma_video.mp4

# Windows natif
grabme.bat "https://cdn.skool.com/.../video.m3u8" "https://cdn.skool.com/.../audio.m3u8" ma_video.mp4
```

### Loom

```bash
./grabme_loom.sh "https://luna.loom.com/.../mediaplaylist-video-bitrate3200.m3u8?Signature=..." video.mp4
```

### YouTube

```bash
./grabme.sh "https://www.youtube.com/watch?v=VIDEO_ID" video.mp4
```

---

## Description des fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Configuration de l'extension Chrome (MV3) |
| `background.js` | Service worker : intercepte les requêtes réseau et détecte les streams |
| `popup.html` | Interface du popup |
| `popup.js` | Logique du popup : affichage, SSE progression, auto-refresh, effacement |
| `server.py` | Serveur Flask : reçoit les URLs, pilote FFmpeg/yt-dlp, stream la progression via SSE |
| `grabme.sh` | Script CLI unifié (Skool / Loom / YouTube) pour Git Bash Windows |
| `grabme_loom.sh` | Script CLI dédié Loom (reconstruction m3u8 + FFmpeg) |
| `grabme.bat` | Script CLI Skool pour Windows natif (cmd/PowerShell) |
| `native_host.py` | Alternative au serveur Flask via Native Messaging Chrome |
| `native_host.bat` | Lanceur Windows pour native_host.py |
| `com.skool.grabme.json` | Manifeste Native Messaging Host |
| `install_native_host.bat` | Installateur : enregistre le host dans le registre Windows |

---

## Mode Native Messaging (alternative au serveur Flask)

### Qu'est-ce que c'est ?

Le Native Messaging est une API Chrome qui permet à une extension de communiquer directement avec un programme installé sur la machine, **sans passer par un serveur HTTP**. Chrome lance le programme automatiquement à la demande et le ferme quand l'extension n'en a plus besoin.

**Avantages** par rapport au serveur Flask :
- Pas de serveur à démarrer manuellement
- Pas de port réseau occupé
- Plus propre pour une distribution publique

**Inconvénients** :
- Pas de progression SSE en temps réel (communication synchrone stdin/stdout)
- Nécessite une entrée dans le registre Windows (via `install_native_host.bat`)

### Installation Native Messaging

1. Récupérer l'ID de l'extension : `chrome://extensions` → copier l'ID affiché
2. Éditer `com.skool.grabme.json` → remplacer `REMPLACE_PAR_TON_EXTENSION_ID` par l'ID réel
3. Double-cliquer `install_native_host.bat` (met à jour le JSON + enregistre dans le registre)
4. Recharger l'extension dans `chrome://extensions`

### Activer le mode Native Messaging dans l'extension

> **Note :** le mode Native Messaging est implémenté dans `native_host.py` mais l'extension utilise actuellement le mode Flask par défaut. Pour basculer, modifier `popup.js` pour utiliser `chrome.runtime.connectNative('com.skool.grabme')` à la place du `fetch` vers Flask.

---

## Publication Chrome Web Store — état actuel

### Ce qui fonctionne déjà ✅

- Manifest V3 (requis par le Store)
- Permissions déclarées correctement
- Fonctionnalité claire et ciblée

### Ce qui bloque la publication ❌

| Problème | Raison | Solution |
|---|---|---|
| **Dépendance serveur local** | Le Store n'accepte pas les extensions qui nécessitent d'installer et démarrer un serveur Python manuellement | Passer au mode Native Messaging (auto-lancé par Chrome) + créer un installateur MSI/EXE |
| **`host_permissions: <all_urls>`** | Permission très large, examinée attentivement par Google | Restreindre à `*://*.skool.com/*`, `*://*.loom.com/*`, `*://youtube.com/*` |
| **Pas de Privacy Policy** | Obligatoire si l'extension accède aux données réseau | Créer une page web avec la politique de confidentialité |
| **Icônes manquantes** | Le Store exige 16×16, 48×48 et 128×128 px | Créer les icônes et les déclarer dans manifest.json |
| **Pas de screenshots** | Requis pour la fiche Store | Capturer le popup en action |

### Chemin vers la publication

```
Étape 1 : Implémenter Native Messaging comme mode principal (plus de Flask)
Étape 2 : Créer un installateur Windows (MSI ou NSIS) qui installe Python, FFmpeg, yt-dlp et enregistre le host
Étape 3 : Restreindre host_permissions aux domaines nécessaires
Étape 4 : Créer la Privacy Policy, les icônes, les screenshots
Étape 5 : Compte développeur Chrome Web Store (5$ unique)
Étape 6 : Soumettre pour review (délai : 1-7 jours)
```

### En attendant

L'extension peut être distribuée en dehors du Store :
- Partage du dossier → chargement en mode développeur (non empaquetée)
- Création d'un fichier `.crx` signé pour distribution directe
- Publication en tant qu'extension **non listée** (accessible via lien direct)
