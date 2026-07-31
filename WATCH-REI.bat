@echo off
cd /d "%~dp0"
set SANDBOX=false
set WATCH_ONLY=true
set HEADLESS=false
echo ============================================================
echo   Level 10 SMS Outreach - WATCH mode (checks REI, sends nothing)
echo   Keep this window OPEN. Then open http://localhost:3000
echo ============================================================
node server/index.js
echo.
echo (The server stopped. Read any message above, then close this window.)
pause
