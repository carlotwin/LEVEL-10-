@echo off
cd /d "%~dp0"
set SANDBOX=false
set WATCH_ONLY=false
set ALLOW_LIVE_SEND=true
set HEADLESS=false
set REIBB_LOGIN_URL=https://my.reiblackbook.com/services/account/login
echo ============================================================
echo   Level 10 SMS Outreach - LIVE SEND (REAL text messages)
echo   Approved messages WILL be sent to real homeowners when a
echo   lead passes every check (opt-in, correct ProfitDial, etc).
echo   A Chrome window opens - log into REI there once.
echo   Keep this window OPEN. Then open http://localhost:3000
echo ============================================================
node server/index.js
echo.
echo (The server stopped. Read any message above, then close this window.)
pause
