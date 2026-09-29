@echo off
cd /d "%~dp0"
echo ============================================================
echo   Twin PPC - sync once (Google Ads, GA4, REI, landing pages)
echo   Reads data only. Nothing is changed in Google Ads or REI.
echo ============================================================
node ppc/agent/cli.js sync
echo.
echo (Done. Read any message above, then close this window.)
pause
