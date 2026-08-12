@echo off
REM Walk through first-run setup as a NEW user sees it.
REM
REM Uses a throwaway profile (.dev-profile in this folder), so the app believes it is a brand new
REM install: the setup wizard opens, no widget layout exists, no account is connected.
REM
REM Sync is HARD-DISABLED for this profile, so it is safe to paste a real token into the wizard —
REM every push is a full replace, and an empty throwaway collection would otherwise overwrite the
REM real one on subliminal.gg.
REM
REM Quit any other copy of SC Overlay first: they both want port 8778.
REM
REM Add  --reset  to wipe the throwaway profile and get a true first run again.
cd /d "%~dp0"
node tools/dev-fresh.mjs %*
pause
