"""
Native Messaging Host — alternative au serveur Flask.

Chrome lance ce script automatiquement quand l'extension appelle
chrome.runtime.connectNative('com.skool.grabme').
Communication via stdin/stdout avec des messages JSON préfixés d'un uint32 (longueur).

Avantage : aucun serveur à démarrer manuellement.
Limitation : pas de progression en temps réel (contrairement au mode Flask+SSE).
"""

import sys
import json
import struct
import subprocess
import re
import os
import tempfile
from pathlib import Path

DOWNLOADS_DIR = Path.home() / "Downloads"
TEMP_DIR = Path(tempfile.gettempdir()) / "grabme_dl"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# Protocole Native Messaging (Chrome <-> script Python via stdin/stdout)
# ---------------------------------------------------------------------------

def read_message() -> dict | None:
    raw = sys.stdin.buffer.read(4)
    if not raw:
        return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(msg: dict):
    encoded = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip()
    return name[:80] or "video"


def unique_path(stem: str) -> str:
    path = DOWNLOADS_DIR / f"{stem}.mp4"
    i = 1
    while path.exists():
        path = DOWNLOADS_DIR / f"{stem}_{i}.mp4"
        i += 1
    return str(path)


# ---------------------------------------------------------------------------
# Téléchargements
# ---------------------------------------------------------------------------

def download_loom(url_entree: str, fichier_sortie: str) -> str:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    raw_video   = TEMP_DIR / "raw_video.m3u8"
    raw_audio   = TEMP_DIR / "raw_audio.m3u8"
    local_video = TEMP_DIR / "local_video.m3u8"
    local_audio = TEMP_DIR / "local_audio.m3u8"

    url_video = url_entree
    if "mediaplaylist-audio" in url_entree:
        url_video = url_entree.replace("mediaplaylist-audio.m3u8", "mediaplaylist-video-bitrate3200.m3u8")
    elif "playlist.m3u8" in url_entree:
        url_video = url_entree.replace("playlist.m3u8", "mediaplaylist-video-bitrate3200.m3u8")
    url_audio = url_video.replace("mediaplaylist-video-bitrate3200.m3u8", "mediaplaylist-audio.m3u8")

    m = re.match(r"(.*resource/hls/).*", url_video)
    if not m:
        raise ValueError("URL Loom non reconnue")
    base = m.group(1)
    qs = "?" + url_video.split("?")[1]

    for url, dest in [(url_video, raw_video), (url_audio, raw_audio)]:
        subprocess.run(
            ["curl", "-s", "-A", USER_AGENT,
             "-H", "Origin: https://www.loom.com",
             "-H", "Referer: https://www.loom.com/",
             url, "-o", str(dest)],
            check=True, capture_output=True
        )

    if not raw_video.exists() or raw_video.stat().st_size == 0:
        raise ValueError("Impossible de récupérer l'index vidéo Loom")

    for raw, local in [(raw_video, local_video), (raw_audio, local_audio)]:
        if raw.exists() and raw.stat().st_size > 0:
            with open(raw, encoding="utf-8") as fin, \
                 open(local, "w", encoding="utf-8", newline="\n") as fout:
                for line in fin:
                    clean = line.strip()
                    fout.write(f"{base}{clean}{qs}\n" if clean.endswith(".ts") else clean + "\n")

    whitelist = "file,crypto,https,tcp,tls"
    has_audio = local_audio.exists() and local_audio.stat().st_size > 0
    cmd = ["ffmpeg", "-protocol_whitelist", whitelist, "-i", str(local_video)]
    if has_audio:
        cmd += ["-protocol_whitelist", whitelist, "-i", str(local_audio)]
    cmd += ["-c", "copy", "-y", fichier_sortie]
    subprocess.run(cmd, check=True, capture_output=True)

    for f in [raw_video, raw_audio, local_video, local_audio]:
        if f.exists():
            f.unlink()

    return fichier_sortie


def download_youtube(url: str, fichier_sortie: str) -> str:
    try:
        result = subprocess.run(
            ["yt-dlp", "--print", "title", "--no-playlist", url],
            capture_output=True, text=True, check=True, timeout=15
        )
        yt_title = result.stdout.strip()
        if yt_title:
            fichier_sortie = unique_path(safe_filename(yt_title))
    except Exception:
        pass

    subprocess.run(
        ["yt-dlp",
         "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
         "--merge-output-format", "mp4",
         "--no-playlist",
         "-o", fichier_sortie,
         url],
        check=True, capture_output=True
    )
    return fichier_sortie


def download_skool(url: str, fichier_sortie: str) -> str:
    subprocess.run(
        ["ffmpeg",
         "-user_agent", USER_AGENT,
         "-headers", "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n",
         "-i", url,
         "-map", "0",
         "-c", "copy", "-y", fichier_sortie],
        check=True, capture_output=True
    )
    return fichier_sortie


def handle(msg: dict) -> dict:
    url   = msg.get("url", "").strip()
    title = msg.get("title", "")

    if not url:
        return {"status": "error", "message": "URL manquante"}

    stem   = safe_filename(title) if title else "video"
    output = unique_path(stem)

    try:
        if "loom.com" in url:
            output = download_loom(url, output)
        elif "youtube.com" in url or "youtu.be" in url:
            output = download_youtube(url, output)
        else:
            output = download_skool(url, output)

        if os.path.exists(output):
            return {"status": "success", "filename": os.path.basename(output)}
        return {"status": "error", "message": "Fichier non généré"}

    except FileNotFoundError:
        tool = "yt-dlp" if ("youtube" in url or "youtu.be" in url) else "ffmpeg ou curl"
        return {"status": "error", "message": f"{tool} introuvable dans le PATH"}
    except subprocess.CalledProcessError as e:
        stderr = getattr(e, "stderr", b"")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        return {"status": "error", "message": stderr[-300:] or str(e)}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# Boucle principale
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    while True:
        msg = read_message()
        if msg is None:
            break
        if msg.get("action") == "download":
            send_message(handle(msg))
