@echo off
cd /d "%~dp0"
echo ============================================================
echo   REI Selector Recorder
echo   A REI window + a "Playwright Inspector" window will open.
echo   1) Log into REI.
echo   2) Click through: open a contact -> Chat tab -> the From:
echo      number picker -> the pencil/Edit Contact modal.
echo   3) STOP before Send.
echo   4) Copy ALL the code shown in the Inspector window and send it.
echo ============================================================
npx playwright codegen "https://my.reiblackbook.com/services/account/login"
echo.
pause
