@echo off
setlocal

:: ============================================================
:: Installateur du Native Messaging Host pour GrabMe
:: Enregistre le host dans le registre Windows pour Chrome.
::
:: Après installation : rechargez l'extension dans Chrome
:: (chrome://extensions > bouton "Recharger").
:: ============================================================

set "JSON_PATH=%~dp0com.skool.grabme.json"
set "BAT_PATH=%~dp0native_host.bat"

:: Réécrire le JSON avec le chemin absolu vers native_host.bat
:: (Python génère le JSON proprement pour éviter les problèmes d'échappement)
python -c "
import json, sys
path = r'%BAT_PATH%'
with open(r'%JSON_PATH%', 'r') as f:
    d = json.load(f)
d['path'] = path
with open(r'%JSON_PATH%', 'w') as f:
    json.dump(d, f, indent=2)
print('JSON mis a jour :', path)
"

if %errorlevel% neq 0 (
    echo ERREUR : Python introuvable. Installez Python et reessayez.
    pause
    exit /b 1
)

:: Enregistrement dans le registre utilisateur (pas besoin d'admin)
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.skool.grabme" ^
    /ve /t REG_SZ /d "%JSON_PATH%" /f

if %errorlevel% equ 0 (
    echo.
    echo Native Messaging Host installe avec succes !
    echo Rechargez l'extension dans chrome://extensions
) else (
    echo ERREUR lors de l'ecriture dans le registre.
)

pause
endlocal
