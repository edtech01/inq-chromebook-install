@echo off
cd /d "%~dp0"
start "Inquisitor Server" python -m http.server 3334
timeout /t 1 >nul
start "" chrome "http://localhost:3334"
