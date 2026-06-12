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
import urllib.request
import urllib.parse
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


def run_ytdlp(url: str, fichier_sortie: str, q: queue.Queue,
              format_str: str = "", progress_label: str = "Téléchargement...",
              referer: str = "") -> str:
    """Télécharge via yt-dlp (YouTube, Vimeo page, Shorts…).
    referer : site hôte transmis à yt-dlp pour les vidéos domain-restricted.
    """
    push(q, {"type": "progress", "label": "Récupération titre..."})
    extra = ["--referer", referer] if referer else []
    try:
        result = subprocess.run(
            ["yt-dlp", "--print", "title", "--no-playlist"] + extra + [url],
            capture_output=True, text=True, check=True, timeout=15
        )
        title = result.stdout.strip()
        if title:
            fichier_sortie = unique_path(safe_filename(title))
    except Exception:
        pass

    temp_output = str(TEMP_DIR / f"{uuid.uuid4()}.mp4")
    fmt = format_str or "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"

    push(q, {"type": "progress", "label": progress_label, "percent": 0})
    process = subprocess.Popen(
        ["yt-dlp", "-f", fmt,
         "--merge-output-format", "mp4",
         "--no-playlist"] + extra + ["-o", temp_output, url],
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

    shutil.move(temp_output, fichier_sortie)
    return fichier_sortie


def run_youtube(url: str, fichier_sortie: str, q: queue.Queue,
                format_str: str = "", referer: str = "") -> str:
    return run_ytdlp(url, fichier_sortie, q, format_str, "Téléchargement YouTube...", referer)


def run_vimeo(url_entree: str, fichier_sortie: str, q: queue.Queue, audio_url: str = ""):
    """Vimeo CDN (URLs pré-signées CloudFront).
    - Master playlist : FFmpeg résout EXT-X-MEDIA et inclut l'audio automatiquement (pas de -map).
    - Variant vidéo + URL audio capturée : fusion deux entrées FFmpeg.
    """
    push(q, {"type": "progress", "label": "Téléchargement Vimeo..."})

    if audio_url:
        # URL audio réelle capturée par background.js — fusion deux inputs
        cmd = ["ffmpeg",
               "-i", url_entree,
               "-i", audio_url,
               "-map", "0:v:0?",
               "-map", "1:a:0?",
               "-c", "copy", "-y", fichier_sortie]
    else:
        # Master playlist (ou stream muxé) — laisser FFmpeg gérer EXT-X-MEDIA
        # NB : pas de -map pour ne pas bloquer la résolution automatique des groupes audio HLS
        cmd = ["ffmpeg",
               "-i", url_entree,
               "-c", "copy", "-y", fichier_sortie]

    run_ffmpeg(cmd, q)


SKOOL_HEADERS = "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n"


def run_skool(url_entree: str, fichier_sortie: str, q: queue.Queue, audio_url: str = ""):
    push(q, {"type": "progress", "label": "Téléchargement Skool..."})
    # Options HTTP communes (per-input en FFmpeg 8.x)
    http_opts = ["-user_agent", USER_AGENT, "-headers", SKOOL_HEADERS]
    if audio_url:
        cmd = ["ffmpeg"] + http_opts + ["-i", url_entree] \
                         + http_opts + ["-i", audio_url,
                                        "-map", "0:v:0?", "-map", "1:a:0?",
                                        "-c", "copy", "-y", fichier_sortie]
    else:
        cmd = ["ffmpeg"] + http_opts + ["-i", url_entree,
                                        "-map", "0:v:0?", "-map", "0:a:0?",
                                        "-c", "copy", "-y", fichier_sortie]
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
        raise subprocess.CalledProcessError(process.returncode, "ffmpeg", stderr=context)


def _update_job(job_id: str, **kwargs):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


def download_worker(job_id: str, url: str, fichier_sortie: str,
                    format_str: str = "", audio_url: str = "", referer: str = ""):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return
    q = job["q"]
    try:
        if "loom.com" in url:
            run_loom(url, fichier_sortie, q)
        elif "youtube.com" in url or "youtu.be" in url:
            fichier_sortie = run_ytdlp(url, fichier_sortie, q, format_str, "Téléchargement YouTube...", referer)
        elif "vimeo.com" in url and "vimeocdn.com" not in url:
            fichier_sortie = run_ytdlp(url, fichier_sortie, q, format_str, "Téléchargement Vimeo...", referer)
        elif "wistia.com" in url:
            fichier_sortie = run_ytdlp(url, fichier_sortie, q, format_str, "Téléchargement Wistia...", referer)
        elif "vimeocdn.com" in url:
            actual = format_str if format_str.startswith("http") else url
            run_vimeo(actual, fichier_sortie, q, audio_url)
        else:
            actual = format_str if format_str.startswith("http") else url
            run_skool(actual, fichier_sortie, q, audio_url)

        if os.path.exists(fichier_sortie):
            fname = os.path.basename(fichier_sortie)
            _update_job(job_id, status="done", filename=fname)
            push(q, {"type": "done", "filename": fname})
        else:
            msg = "Fichier non généré par FFmpeg/yt-dlp"
            _update_job(job_id, status="error", message=msg)
            push(q, {"type": "error", "message": msg})

    except FileNotFoundError:
        tool = "yt-dlp" if ("youtube" in url or "youtu.be" in url or "wistia.com" in url) else "ffmpeg ou curl"
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


@app.route("/qualities", methods=["GET"])
def get_qualities():
    url     = request.args.get("url", "").strip()
    referer = request.args.get("referer", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    try:
        # YouTube / Shorts / Vimeo page (yt-dlp)
        if "youtube.com" in url or "youtu.be" in url or \
           ("vimeo.com" in url and "vimeocdn.com" not in url) or \
           "wistia.com" in url:
            extra = ["--referer", referer] if referer else []
            result = subprocess.run(
                ["yt-dlp", "--dump-json", "--no-playlist"] + extra + [url],
                capture_output=True, text=True, timeout=20,
                encoding="utf-8", errors="replace"
            )
            if not result.stdout.strip():
                err = result.stderr.strip()[-300:] if result.stderr else "yt-dlp n'a retourné aucune info"
                return jsonify({"error": err}), 500
            try:
                info = json.loads(result.stdout)
            except json.JSONDecodeError:
                return jsonify({"error": f"Réponse inattendue de yt-dlp : {result.stderr[:200]}"}), 500
            seen = set()
            qualities = []
            for f in reversed(info.get("formats", [])):
                h = f.get("height")
                if not h or f.get("vcodec", "none") == "none":
                    continue
                if h in seen:
                    continue
                seen.add(h)
                fmt = (f"bestvideo[height={h}][ext=mp4]+bestaudio[ext=m4a]"
                       f"/bestvideo[height={h}]+bestaudio/best[height<={h}]")
                qualities.append({"label": f"{h}p", "value": fmt, "height": h})
            qualities.sort(key=lambda x: x["height"], reverse=True)
            if "vimeo.com" in url:
                platform = "vimeo"
            elif "wistia.com" in url:
                platform = "wistia"
            else:
                platform = "youtube"
            return jsonify({"platform": platform, "qualities": qualities[:8]})

        # Loom — bitrates fixes
        if "loom.com" in url:
            base = re.sub(r"mediaplaylist-video-bitrate\d+\.m3u8.*", "", url)
            qs = "?" + url.split("?")[1] if "?" in url else ""
            qualities = [
                {"label": "3200k (HD)", "value": f"{base}mediaplaylist-video-bitrate3200.m3u8{qs}"},
                {"label": "1800k",      "value": f"{base}mediaplaylist-video-bitrate1800.m3u8{qs}"},
                {"label": "700k",       "value": f"{base}mediaplaylist-video-bitrate700.m3u8{qs}"},
            ]
            return jsonify({"platform": "loom", "qualities": qualities})

        # Skool / Vimeo — master HLS playlist
        req = urllib.request.Request(url)
        req.add_header("User-Agent", USER_AGENT)
        is_vimeo = "vimeocdn.com" in url
        if not is_vimeo:
            req.add_header("Origin", "https://www.skool.com")
            req.add_header("Referer", "https://www.skool.com/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="replace")

        # Préserver le query string du master (tokens CloudFront) lors de la résolution
        # des URLs relatives — urljoin seul supprime le query string de la base
        parsed_master = urllib.parse.urlparse(url)
        master_qs = ("?" + parsed_master.query) if parsed_master.query else ""
        master_base = urllib.parse.urlunparse(parsed_master._replace(query="", fragment=""))

        def resolve(rel):
            if rel.startswith("http"):
                return rel
            return urllib.parse.urljoin(master_base, rel) + master_qs

        # Extraire l'URL audio depuis EXT-X-MEDIA (groupe audio séparé)
        audio_uri = ""
        for raw in content.strip().splitlines():
            raw = raw.strip()
            if raw.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in raw:
                m_uri = re.search(r'URI="([^"]+)"', raw)
                if m_uri:
                    audio_uri = resolve(m_uri.group(1))
                    break

        qualities = []
        lines = content.strip().splitlines()
        for i, line in enumerate(lines):
            line = line.strip()
            if not line.startswith("#EXT-X-STREAM-INF"):
                continue
            res_m = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            bw_m  = re.search(r"BANDWIDTH=(\d+)", line)
            variant_raw = next((lines[j].strip() for j in range(i+1, len(lines))
                                if lines[j].strip() and not lines[j].startswith("#")), "")
            if not variant_raw:
                continue
            variant = resolve(variant_raw)
            h  = int(res_m.group(2)) if res_m else 0
            bw = int(bw_m.group(1))  if bw_m  else 0
            qualities.append({"label": f"{h}p" if h else f"{bw//1000}k",
                               "value": variant, "audioUrl": audio_uri,
                               "height": h, "bandwidth": bw})

        qualities.sort(key=lambda x: x["bandwidth"], reverse=True)
        seen_labels, unique = set(), []
        for q in qualities:
            if q["label"] not in seen_labels:
                seen_labels.add(q["label"])
                unique.append(q)

        platform = "vimeo" if is_vimeo else "skool"
        return jsonify({"platform": platform, "qualities": unique or
                        [{"label": "Meilleure qualité", "value": url, "audioUrl": ""}]})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/download", methods=["POST"])
def download():
    data = request.json or {}
    url = data.get("url", "").strip()
    title = data.get("title", "")
    format_str = data.get("format", "").strip()
    audio_url  = data.get("audioUrl", "").strip()
    referer    = data.get("referer", "").strip()

    if not url:
        return jsonify({"status": "error", "message": "URL manquante"}), 400

    job_id = str(uuid.uuid4())
    q = queue.Queue()
    with _jobs_lock:
        _jobs[job_id] = {"q": q, "status": "running", "filename": "", "message": ""}

    stem = safe_filename(title) if title else "video"
    fichier_sortie = unique_path(stem)

    threading.Thread(
        target=download_worker, args=(job_id, url, fichier_sortie, format_str, audio_url, referer), daemon=True
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
