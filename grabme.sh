#!/bin/bash

if [ -z "$1" ]; then
    echo "Erreur : Lien m3u8 manquant."
    echo "Usage: $0 <URL_M3U8> [NOM_SORTIE.mp4]"
    exit 1
fi

M3U8_URL="$1"
OUTPUT_NAME="${2:-output.mp4}"
USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# Loom a des pistes vidéo/audio séparées — délégation au script dédié
if [[ "$M3U8_URL" == *"loom.com"* ]]; then
    echo "🎯 Détection Loom — délégation à grabme_loom.sh"
    SCRIPT_DIR="$(dirname "$(realpath "$0")")"
    bash "$SCRIPT_DIR/grabme_loom.sh" "$M3U8_URL" "$OUTPUT_NAME"
    exit $?
fi

# YouTube — téléchargement via yt-dlp
if [[ "$M3U8_URL" == *"youtube.com"* ]] || [[ "$M3U8_URL" == *"youtu.be"* ]]; then
    echo "▶️ Détection YouTube — téléchargement via yt-dlp"
    yt-dlp \
        -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
        --merge-output-format mp4 \
        --no-playlist \
        -o "$OUTPUT_NAME" \
        "$M3U8_URL"
    if [ $? -eq 0 ]; then
        echo ""
        echo "✅ Succès ! Vidéo sauvegardée sous : $OUTPUT_NAME"
    else
        echo ""
        echo "❌ Échec yt-dlp. Vérifiez qu'il est installé (pip install yt-dlp)."
    fi
    exit $?
fi

echo "==================================================="
echo " Mode : SKOOL NATIVE"
echo " Fichier de sortie : $OUTPUT_NAME"
echo "==================================================="

ffmpeg -user_agent "$USER_AGENT" \
       -headers $'Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n' \
       -i "$M3U8_URL" \
       -map 0:v -map 0:a \
       -c copy "$OUTPUT_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Succès ! Vidéo sauvegardée sous : $OUTPUT_NAME"
else
    echo ""
    echo "❌ Échec. Vérifiez la validité du lien."
fi
