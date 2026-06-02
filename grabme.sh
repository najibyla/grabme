#!/bin/bash
# grabme.sh — télécharge une vidéo depuis une URL copiée dans le popup GrabMe
# Usage: ./grabme.sh <URL> [nom_sortie.mp4]

if [ -z "$1" ]; then
    echo "Usage: $0 <URL> [nom_sortie.mp4]"
    echo ""
    echo "URLs supportées :"
    echo "  Skool   : https://...cloudfront.net/.../master.m3u8?..."
    echo "  Loom    : https://luna.loom.com/.../mediaplaylist-video-bitrate3200.m3u8?..."
    echo "  YouTube : https://www.youtube.com/watch?v=... ou /shorts/..."
    echo "  Vimeo   : https://skyfire.vimeocdn.com/.../*.m3u8?..."
    exit 1
fi

URL="$1"
OUTPUT="${2:-output.mp4}"
USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
SCRIPT_DIR="$(dirname "$(realpath "$0")")"

# ─── Loom ────────────────────────────────────────────────────────────────────
if [[ "$URL" == *"loom.com"* ]]; then
    echo "🎬 Détection Loom — délégation à grabme_loom.sh"
    bash "$SCRIPT_DIR/grabme_loom.sh" "$URL" "$OUTPUT"
    exit $?
fi

# ─── YouTube / Shorts ────────────────────────────────────────────────────────
if [[ "$URL" == *"youtube.com"* ]] || [[ "$URL" == *"youtu.be"* ]]; then
    echo "▶️ Détection YouTube — téléchargement via yt-dlp"
    yt-dlp \
        -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
        --merge-output-format mp4 \
        --no-playlist \
        -o "$OUTPUT" \
        "$URL"
    [ $? -eq 0 ] && echo "✅ Vidéo sauvegardée : $OUTPUT" || echo "❌ Échec yt-dlp."
    exit $?
fi

# ─── Vimeo (vimeocdn.com — URLs pré-signées CDN) ────────────────────────────
if [[ "$URL" == *"vimeocdn.com"* ]]; then
    echo "🎬 Détection Vimeo — téléchargement via FFmpeg"
    ffmpeg -i "$URL" \
           -map 0:v:0 -map 0:a:0 \
           -c copy -y "$OUTPUT"
    [ $? -eq 0 ] && echo "✅ Vidéo sauvegardée : $OUTPUT" || echo "❌ Échec FFmpeg."
    exit $?
fi

# ─── Skool / HLS générique ───────────────────────────────────────────────────
echo "⭐ Mode Skool / HLS — téléchargement via FFmpeg"
ffmpeg -user_agent "$USER_AGENT" \
       -headers $'Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n' \
       -i "$URL" \
       -map 0:v:0 -map 0:a:0 \
       -c copy -y "$OUTPUT"
[ $? -eq 0 ] && echo "✅ Vidéo sauvegardée : $OUTPUT" || echo "❌ Échec. Vérifiez la validité du lien (peut avoir expiré)."
