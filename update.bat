@echo off
cd /d "%~dp0"
echo =====================================================
echo   Applying Microsoft Edge Patch to Antigravity...
echo =====================================================
node scripts\install.js --force
echo.
echo Done! You can now use the /browser command in Antigravity.
pause
