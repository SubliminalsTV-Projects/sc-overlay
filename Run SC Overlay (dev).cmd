@echo off
REM Launch the DEV overlay (runs from source, sidecar via tsx on :8778).
REM
REM Double-click this from Explorer. That matters: launching it from inside another
REM packaged app's process tree (e.g. an MSIX/Store app) makes Windows silently
REM redirect %APPDATA%, and the app then reads and writes a DIFFERENT config.json
REM than your real one -- settings appear not to stick and the patch-notes card
REM returns every launch. Started from Explorer, it gets your real environment.
REM
REM For in-game hotkeys over Star Citizen, right-click this file -> Run as administrator.
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" "electron/main.cjs"
