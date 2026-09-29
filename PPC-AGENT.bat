@echo off
cd /d "%~dp0"
echo ============================================================
echo   Twin PPC - sync agent (runs the syncs on their schedules)
echo   Keep this window open. Close it to stop.
echo ============================================================
node ppc/agent/cli.js schedule
echo.
echo (The agent stopped. Read any message above, then close this window.)
pause
