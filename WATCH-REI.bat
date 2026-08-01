@echo off
cd /d "%~dp0"
rem Reset EVERY mode flag explicitly -- if another launcher ran earlier in
rem this same window, "set" leaves those values active for the rest of the
rem session, which would otherwise leak into this run.
set SANDBOX=false
set WATCH_ONLY=true
set ALLOW_LIVE_SEND=false
set HEADLESS=false
echo ============================================================
echo   Level 10 SMS Outreach - WATCH mode (checks REI, sends nothing)
echo   Keep this window OPEN. Then open http://localhost:3000
echo ============================================================
node server/index.js
echo.
echo (The server stopped. Read any message above, then close this window.)
pause
