@echo off
:: Lanceur Windows pour le Native Messaging Host.
:: Chrome ne peut pas appeler un .py directement — ce .bat fait le pont.
:: Ce fichier doit rester dans le même dossier que native_host.py.
python "%~dp0native_host.py" %*
