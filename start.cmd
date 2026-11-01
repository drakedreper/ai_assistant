@echo off
rem Run Mira from a clone: install, build the web app, start the daemon and open the app in your browser.
rem Everything runs locally with the fake Claude (no network, no tokens) unless you set CLAUDE_BACKEND=sdk first.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>22||(a===22&&b>=14)?0:1)"
if errorlevel 1 goto nonode

where pnpm >nul 2>nul
if not errorlevel 1 goto havepnpm
echo Enabling pnpm...
call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 call npm install -g pnpm
:havepnpm

echo Installing dependencies (a few minutes the first time)...
call pnpm install --frozen-lockfile
if errorlevel 1 goto failed
call pnpm --filter @ai-assistant/daemon check-native
if errorlevel 1 goto failed
echo Building the app...
call pnpm --filter @ai-assistant/web build
if errorlevel 1 goto failed
echo Starting Mira. Close this window to stop her.
if not defined OPEN_BROWSER set OPEN_BROWSER=1
call pnpm --filter @ai-assistant/daemon start
pause
exit /b 0

:nonode
echo Node.js 22.14 or newer is needed: https://nodejs.org/
pause
exit /b 1

:failed
echo Something failed. Copy the error text above.
pause
exit /b 1
