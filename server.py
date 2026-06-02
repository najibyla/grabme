from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import os
import re
import json
import shutil
import subprocess
import threading
import queue
import uuid
import tempfile
from pathlib import Path

app = Flask(__name__)
CORS(app)

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
DOWNLOADS_DIR = Path.home() / "Downloads"
TEMP_DIR = Path(tempfile.gettempdir()) / "grabme_dl"

_jobs: dict = {}        # job_id -> {"q": Queue, "status": str, "filename": str, "message": str}
_jobs_lock = threading.Lock()


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name).strip()
    return name[:80] or "video"


def unique_path(stem: str) -> str:
    path = DOWNLOADS_DIR / f"{stem}.mp4"
    i = 1
    while path.exists():
        path = DOWNLOADS_DIR / f"{stem}_{i}.mp4"
        i += 1
    return str(path)


def push(q: queue.Queue, msg: dict):
    q.put(msg)


def run_ffmpeg(cmd: list, q: queue.Queue):
    """Lance FFmpeg, remonte la progression via le temps, lève une exception avec contexte stderr."""
    process = subprocess.Popen(
        cmd, stderr=subprocess.PIPE,
        universal_newlines=True, encoding="utf-8", errors="replace"
    )
    stderr_buf = []
    for line in process.stderr:
        stderr_buf.append(line)
        m = re.search(r"time=(\d+:\d+:\d+)", line)
        if m:
            push(q, {"type": "progress", "time": m.group(1)})
    process.wait()
    if process.returncode != 0:
        context = "".join(stderr_buf[-8:]).strip()
        raise subprocess.CalledProcessError(process.returncode, cmd, stderr=context)


def run_loom(url_entree: str, fichier_sortie: str, q: queue.Queue):
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    raw_video   = TEMP_DIR / "raw_video.m3u8"
    raw_audio   = TEMP_DIR / "raw_audio.m3u8"
    local_video = TEMP_DIR / "local_video.m3u8"
    local_audio = TEMP_DIR / "local_audio.m3u8"

    for f in [raw_video, raw_audio, local_video, local_audio]:
        if f.exists():
            f.unlink()

    url_video = url_entree
    if "mediaplaylist-audio" in url_entree:
        url_video = url_entree.replace("mediaplaylist-audio.m3u8", "mediaplaylist-video-bitrate3200.m3u8")
    elif "playlist.m3u8" in url_entree:
        url_video = url_entree.replace("playlist.m3u8", "mediaplaylist-video-bitrate3200.m3u8")
    url_audio = url_video.replace("mediaplaylist-video-bitrate3200.m3u8", "mediaplaylist-audio.m3u8")

    m = re.match(r"(.*resource/hls/).*", url_video)
    if not m:
        raise ValueError("URL Loom non reconnue (chemin resource/hls/ introuvable)")
    base = m.group(1)
    qs = "?" + url_video.split("?")[1]

    push(q, {"type": "progress", "label": "Téléchargement manifestes..."})
    for url, dest in [(url_video, raw_video), (url_audio, raw_audio)]:
        subprocess.run(
            ["curl", "-s", "-A", USER_AGENT,
             "-H", "Origin: https://www.loom.com",
             "-H", "Referer: https://www.loom.com/",
             url, "-o", str(dest)],
            check=True
        )

    if not raw_video.exists() or raw_video.stat().st_size == 0:
        raise ValueError("Impossible de récupérer l'index vidéo Loom")

    push(q, {"type": "progress", "label": "Reconstruction segments..."})
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

    push(q, {"type": "progress", "label": "Compilation FFmpeg..."})
    run_ffmpeg(cmd, q)

    for f in [raw_video, raw_audio, local_video, local_audio]:
        if f.exists():
            f.unlink()


def run_youtube(url: str, fichier_sortie: str, q: queue.Queue) -> str:
    push(q, {"type": "progress", "label": "Récupération titre YouTube..."})
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

    # Téléchargement vers un chemin ASCII pur (UUID) pour éviter les erreurs de merge
    # sur Windows quand le titre contient des accents (WinError 2 sur les fichiers .fXXX.m4a)
    temp_output = str(TEMP_DIR / f"{uuid.uuid4()}.mp4")

    push(q, {"type": "progress", "label": "Téléchargement YouTube...", "percent": 0})
    process = subprocess.Popen(
        ["yt-dlp",
         "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
         "--merge-output-format", "mp4",
         "--no-playlist",
         "-o", temp_output,
         url],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True, encoding="utf-8", errors="replace"
    )
    out_buf = []
    for line in process.stdout:
        out_buf.append(line)
        m = re.search(r"(\d+\.?\d*)%", line)
        if m:
            push(q, {"type": "progress", "percent": round(float(m.group(1)), 1)})
    process.wait()
    if process.returncode != 0:
        context = "".join(out_buf[-8:]).strip()
        raise subprocess.CalledProcessError(process.returncode, "yt-dlp", stderr=context)

    # Déplacement vers le nom final (avec accents) — shutil gère l'Unicode correctement
    shutil.move(temp_output, fichier_sortie)
    return fichier_sortie


def run_vimeo(url_entree: str, fichier_sortie: str, q: queue.Queue):
    """URLs vimeocdn.com sont pré-signées — FFmpeg peut les lire directement."""
    push(q, {"type": "progress", "label": "Téléchargement Vimeo..."})
    cmd = ["ffmpeg",
           "-i", url_entree,
           "-map", "0:V?", "-map", "0:a?",
           "-c", "copy", "-y", fichier_sortie]
    run_ffmpeg(cmd, q)


def run_skool(url_entree: str, fichier_sortie: str, q: queue.Queue):
    push(q, {"type": "progress", "label": "Téléchargement Skool..."})
    process = subprocess.Popen(
        ["ffmpeg",
         "-user_agent", USER_AGENT,
         "-headers", "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n",
         "-i", url_entree,
         "-map", "0:V?",   # vidéo seulement (exclut WebVTT/sous-titres qui cassent MP4)
         "-map", "0:a?",   # audio seulement — ? = optionnel (audio-only streams OK)
         "-c", "copy", "-y", fichier_sortie],
        stderr=subprocess.PIPE,
        universal_newlines=True, encoding="utf-8", errors="replace"
    )
    stderr_buf = []
    for line in process.stderr:
        stderr_buf.append(line)
        m = re.search(r"time=(\d+:\d+:\d+)", line)
        if m:
            push(q, {"type": "progress", "time": m.group(1)})
    process.wait()
    if process.returncode != 0:
        context = "".join(stderr_buf[-8:]).strip()
        raise subprocess.CalledProcessError(process.returncode, "ffmpeg", stderr=context)


def _update_job(job_id: str, **kwargs):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


def download_worker(job_id: str, url: str, fichier_sortie: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return
    q = job["q"]
    try:
        if "loom.com" in url:
            run_loom(url, fichier_sortie, q)
        elif "youtube.com" in url or "youtu.be" in url:
            fichier_sortie = run_youtube(url, fichier_sortie, q)
        elif "vimeocdn.com" in url or "vimeo.com" in url:
            run_vimeo(url, fichier_sortie, q)
        else:
            run_skool(url, fichier_sortie, q)

        if os.path.exists(fichier_sortie):
            fname = os.path.basename(fichier_sortie)
            _update_job(job_id, status="done", filename=fname)
            push(q, {"type": "done", "filename": fname})
        else:
            msg = "Fichier non généré par FFmpeg/yt-dlp"
            _update_job(job_id, status="error", message=msg)
            push(q, {"type": "error", "message": msg})

    except FileNotFoundError:
        tool = "yt-dlp" if ("youtube" in url or "youtu.be" in url) else "ffmpeg ou curl"
        msg = f"{tool} introuvable — vérifiez le PATH"
        _update_job(job_id, status="error", message=msg)
        push(q, {"type": "error", "message": msg})
    except subprocess.CalledProcessError as e:
        detail = getattr(e, "stderr", "") or str(e)
        msg = detail[-400:] if detail else "Erreur inconnue"
        _update_job(job_id, status="error", message=msg)
        push(q, {"type": "error", "message": msg})
    except Exception as e:
        _update_job(job_id, status="error", message=str(e))
        push(q, {"type": "error", "message": str(e)})


@app.route("/download", methods=["POST"])
def download():
    data = request.json or {}
    url = data.get("url", "").strip()
    title = data.get("title", "")

    if not url:
        return jsonify({"status": "error", "message": "URL manquante"}), 400

    job_id = str(uuid.uuid4())
    q = queue.Queue()
    with _jobs_lock:
        _jobs[job_id] = {"q": q, "status": "running", "filename": "", "message": ""}

    stem = safe_filename(title) if title else "video"
    fichier_sortie = unique_path(stem)

    threading.Thread(
        target=download_worker, args=(job_id, url, fichier_sortie), daemon=True
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def job_status(job_id: str):
    """Endpoint de polling pour le service worker Chrome — retourne l'état sans SSE."""
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return jsonify({"status": "unknown"})
    return jsonify({
        "status": job["status"],
        "filename": job.get("filename", ""),
        "message": job.get("message", "")
    })


@app.route("/progress/<job_id>")
def progress_stream(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return jsonify({"error": "Job inconnu"}), 404
    q = job["q"]

    def generate():
        while True:
            try:
                msg = q.get(timeout=30)
                yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                if msg.get("type") in ("done", "error"):
                    with _jobs_lock:
                        _jobs.pop(job_id, None)
                    break
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'ping'})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Access-Control-Allow-Origin": "*"}
    )


if __name__ == "__main__":
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    app.run(port=5000, debug=False, threaded=True)
