@echo off
setlocal enabledelayedexpansion

:: grabme.bat — télécharge une vidéo depuis une URL copiée dans le popup GrabMe
:: Usage: grabme <URL> [nom_sortie.mp4]
::        grabme <URL_VIDEO_m3u8> <URL_AUDIO_m3u8> nom_sortie.mp4   (dual-stream Skool)

if "%~1"=="" (
    echo Usage : grabme ^<URL^> [nom_sortie.mp4]
    echo.
    echo URLs supportees :
    echo   Skool   : https://...cloudfront.net/.../master.m3u8?...
    echo   YouTube : https://www.youtube.com/watch?v=... ou /shorts/...
    echo   Vimeo   : https://skyfire.vimeocdn.com/.../*.m3u8?...
    echo   Loom    : utiliser grabme_loom.sh depuis Git Bash
    exit /b 1
)

set "USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
set "URL=%~1"

:: ─── Mode dual-stream (3 arguments) ─────────────────────────────────────────
if not "%~3"=="" (
    set "VIDEO_URL=%~1"
    set "AUDIO_URL=%~2"
    set "OUTPUT=%~3"

    echo Mode : Fusion Dual-Stream
    echo Sortie : !OUTPUT!

    ffmpeg -user_agent "%USER_AGENT%" ^
           -headers "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n" ^
           -i "!VIDEO_URL!" ^
           -i "!AUDIO_URL!" ^
           -map 0:v:0 -map 1:a:0 ^
           -c copy -y "!OUTPUT!"
    goto :done
)

set "OUTPUT=%~2"
if "!OUTPUT!"=="" set "OUTPUT=output.mp4"

:: ─── YouTube / Shorts ────────────────────────────────────────────────────────
echo !URL! | findstr /i "youtube.com youtu.be" >nul 2>&1
if !errorlevel! equ 0 (
    echo YouTube detecte — telechargement via yt-dlp
    yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ^
           --merge-output-format mp4 ^
           --no-playlist ^
           -o "!OUTPUT!" ^
           "!URL!"
    goto :done
)

:: ─── Vimeo (vimeocdn.com) ────────────────────────────────────────────────────
echo !URL! | findstr /i "vimeocdn.com" >nul 2>&1
if !errorlevel! equ 0 (
    echo Vimeo detecte — telechargement via FFmpeg
    echo !URL! | findstr /i "/sep/video/" >nul 2>&1
    if !errorlevel! equ 0 (
        echo Fusion audio/video Vimeo...
        :: Deriver l'URL audio depuis l'URL video (meme signature CDN)
        for /f "tokens=*" %%i in ('python -c "import re,sys; u=sys.argv[1]; print(re.sub(r'/sep/video/[^/]+/', '/sep/audio/default/', u))" "!URL!"') do set "AUDIO_URL=%%i"
        ffmpeg -i "!URL!" -i "!AUDIO_URL!" ^
               -map 0:v:0 -map 1:a:0 ^
               -c copy -y "!OUTPUT!"
    ) else (
        ffmpeg -i "!URL!" -c copy -y "!OUTPUT!"
    )
    goto :done
)

:: ─── Loom ────────────────────────────────────────────────────────────────────
echo !URL! | findstr /i "loom.com" >nul 2>&1
if !errorlevel! equ 0 (
    echo Loom detecte — utilisez grabme_loom.sh depuis Git Bash :
    echo   bash grabme_loom.sh "!URL!" "!OUTPUT!"
    exit /b 1
)

:: ─── Skool / HLS générique ───────────────────────────────────────────────────
echo Skool / HLS detecte — telechargement via FFmpeg
ffmpeg -user_agent "%USER_AGENT%" ^
       -headers "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n" ^
       -i "!URL!" ^
       -map 0:v:0 -map 0:a:0 ^
       -c copy -y "!OUTPUT!"

:done
if %errorlevel% equ 0 (
    echo.
    echo Succes ! Fichier : !OUTPUT!
) else (
    echo.
    echo Echec. Le lien a peut-etre expire.
)
endlocal
