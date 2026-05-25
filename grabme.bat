@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Erreur : Lien m3u8 manquant.
    echo.
    echo Usage ^(Stream unique^) :
    echo   grabme "https://.../video.m3u8" video.mp4
    echo.
    echo Usage ^(Video + Audio separes^) :
    echo   grabme "https://.../video.m3u8" "https://.../audio.m3u8" video.mp4
    exit /b 1
)

set "USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

if not "%~3"=="" (
    set "VIDEO_URL=%~1"
    set "AUDIO_URL=%~2"
    set "OUTPUT_NAME=%~3"

    echo ===================================================
    echo  Mode : Fusion Dual-Stream ^(Video + Audio^)
    echo  Fichier de sortie : !OUTPUT_NAME!
    echo ===================================================

    ffmpeg -user_agent "%USER_AGENT%" ^
           -headers "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n" ^
           -i "!VIDEO_URL!" ^
           -i "!AUDIO_URL!" ^
           -c copy "!OUTPUT_NAME!"

) else (
    set "M3U8_URL=%~1"
    set "OUTPUT_NAME=%~2"
    if "!OUTPUT_NAME!"=="" set "OUTPUT_NAME=output.mp4"

    echo ===================================================
    echo  Mode : Stream Unique
    echo  Fichier de sortie : !OUTPUT_NAME!
    echo ===================================================

    ffmpeg -user_agent "%USER_AGENT%" ^
           -headers "Origin: https://www.skool.com\r\nReferer: https://www.skool.com/\r\n" ^
           -i "!M3U8_URL!" ^
           -c copy "!OUTPUT_NAME!"
)

if %errorlevel% equ 0 (
    echo.
    echo Succes ! Video sauvegardee : !OUTPUT_NAME!
) else (
    echo.
    echo Echec. Verifiez le lien ou l'expiration du token.
)

endlocal
