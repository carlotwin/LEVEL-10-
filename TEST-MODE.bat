@echo off
cd /d "%~dp0"
set SANDBOX=true
echo ============================================================
echo   Level 10 SMS Outreach - TEST mode (nothing is ever sent)
echo   Keep this window OPEN. Then open http://localhost:3000
echo   Use "Load sample (demo)" to see how it all works.
echo ============================================================
node server/index.js
echo.
echo (The server stopped. Read any message above, then close this window.)
pause
