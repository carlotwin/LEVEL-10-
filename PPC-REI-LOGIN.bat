@echo off
cd /d "%~dp0"
echo ============================================================
echo   Twin PPC - sign in to REI BlackBook yourself
echo   A browser window opens. Sign in, enter any code REI asks for.
echo   The crawler never bypasses MFA or CAPTCHA; you complete them here.
echo ============================================================
node ppc/agent/cli.js rei-login
echo.
pause
