#!/bin/bash

# Vérification des arguments
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <URL_LOOM_M3U8> <NOM_FICHIER_SORTIE.mp4>"
    exit 1
fi

URL_ENTREE="$1"
FICHIER_SORTIE="$2"

# Nettoyage des fichiers temporaires précédents
rm -f local_video.m3u8 local_audio.m3u8 raw_video.m3u8 raw_audio.m3u8 "$FICHIER_SORTIE"

# 1. Reconstruction des URLs optimales (Vidéo HD 3200k + Audio distinct)
URL_VIDEO="$URL_ENTREE"
if [[ "$URL_ENTREE" == *"mediaplaylist-audio"* ]]; then
    URL_VIDEO=$(echo "$URL_ENTREE" | sed 's/mediaplaylist-audio.m3u8/mediaplaylist-video-bitrate3200.m3u8/')
elif [[ "$URL_ENTREE" == *"playlist.m3u8"* ]]; then
    URL_VIDEO=$(echo "$URL_ENTREE" | sed 's/playlist.m3u8/mediaplaylist-video-bitrate3200.m3u8/')
fi

URL_AUDIO=$(echo "$URL_VIDEO" | sed 's/mediaplaylist-video-bitrate3200.m3u8/mediaplaylist-audio.m3u8/')

echo "🎯 Préparation des sources Loom..."

# Extraction de la racine absolue et de la Query String globale
DOMAINE_BASE=$(echo "$URL_VIDEO" | sed 's|\(.*resource/hls/\).*|\1|')
QUERY_STR="?$(echo "$URL_VIDEO" | cut -d'?' -f2)"

# Émulation du navigateur
USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
HEADERS_LOOM="-H 'Origin: https://www.loom.com' -H 'Referer: https://www.loom.com/'"

echo "📥 Téléchargement des manifestes m3u8 d'origine..."
eval "curl -s -A \"$USER_AGENT\" $HEADERS_LOOM \"$URL_VIDEO\" -o raw_video.m3u8"
eval "curl -s -A \"$USER_AGENT\" $HEADERS_LOOM \"$URL_AUDIO\" -o raw_audio.m3u8"

if [ ! -s raw_video.m3u8 ]; then
    echo "❌ Erreur : Impossible de récupérer l'index vidéo."
    exit 1
fi

echo "⚡ Reconstruction propre des segments (Fix Windows CR/LF)..."
# Reconstruction ligne par ligne sécurisée pour éliminer les corruptions de caractères
while IFS= read -r line || [ -n "$line" ]; do
    clean_line=$(echo "$line" | tr -d '\r\n')
    if [[ "$clean_line" == *".ts"* ]]; then
        echo "${DOMAINE_BASE}${clean_line}${QUERY_STR}" >> local_video.m3u8
    else
        echo "$clean_line" >> local_video.m3u8
    fi
done < raw_video.m3u8

while IFS= read -r line || [ -n "$line" ]; do
    clean_line=$(echo "$line" | tr -d '\r\n')
    if [[ "$clean_line" == *".ts"* ]]; then
        echo "${DOMAINE_BASE}${clean_line}${QUERY_STR}" >> local_audio.m3u8
    else
        echo "$clean_line" >> local_audio.m3u8
    fi
done < raw_audio.m3u8

echo "🚀 Lancement de FFmpeg (Fusion Vidéo HD + Audio)..."

# FFmpeg 8.x : toute option HTTP (-user_agent, -headers) est rejetée pour un fichier local.
# Les segments .ts sont sur des URLs CloudFront pré-signées : aucun header custom requis.
if [ -s local_audio.m3u8 ]; then
    ffmpeg -protocol_whitelist file,crypto,https,tcp,tls \
           -i local_video.m3u8 \
           -protocol_whitelist file,crypto,https,tcp,tls \
           -i local_audio.m3u8 \
           -c copy -y "$FICHIER_SORTIE"
else
    echo "⚠️  Piste audio absente, export vidéo seule..."
    ffmpeg -protocol_whitelist file,crypto,https,tcp,tls \
           -i local_video.m3u8 \
           -c copy -y "$FICHIER_SORTIE"
fi

# Nettoyage final
rm -f local_video.m3u8 local_audio.m3u8 raw_video.m3u8 raw_audio.m3u8

if [ -f "$FICHIER_SORTIE" ]; then
    echo "✅ Téléchargement réussi ! Fichier disponible : $FICHIER_SORTIE"
else
    echo "❌ Échec de la compilation par FFmpeg."
fi