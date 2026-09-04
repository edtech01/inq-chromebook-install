@echo off
cd /d "%~dp0"
set PORT=3334
set URL=http://localhost:%PORT%

echo Inquisitor address: %URL%

rem Don't launch a second server if one is already listening on this port -- Windows will
rem happily let two processes share a port, and then requests land on whichever one the OS
rem feels like that moment (some old code, some new). Just reuse it instead.
netstat -ano | findstr ":%PORT% .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo An Inquisitor server is already running on %URL% -- reusing it.
) else (
    start "Inquisitor Server" python serve.py %PORT%
    timeout /t 1 >nul
)
rem --app opens a borderless app window instead of a normal tab, matching how an installed
rem PWA looks/behaves on the Chromebook. It does NOT by itself make Chrome remember the HID
rem device permission across restarts -- that needs the one-time "Install Inquisitor..."
rem step from Chrome's address bar first. Once installed, --app here just reopens that same
rem installed app's window rather than launching a second, separate (uninstalled) instance.
start "" chrome --app="%URL%"

echo.
echo Inquisitor is running at %URL%
echo If Chrome didn't open on its own, paste that address into a Chrome tab.
echo Keep the "Inquisitor Server" window open while you use the app.
echo.
pause
