@echo off
cd /d "%~dp0"
rem Reset EVERY mode flag explicitly -- if WATCH-REI.bat (or anything else)
rem ran earlier in this same window, "set" leaves those values active for
rem the rest of the session, which would otherwise leak into this run.
set SANDBOX=true
set WATCH_ONLY=false
set ALLOW_LIVE_SEND=false
echo ============================================================
echo   Level 10 SMS Outreach - TEST mode (nothing is ever sent)
echo   Keep this window OPEN. Then open http://localhost:3000
echo   Upload your Level 10 sheet to see how it all works.
echo ============================================================
node server/index.js
echo.
echo (The server stopped. Read any message above, then close this window.)
pause
