@echo off
rem Run Mira's backend in Docker: build the image, start it, print the one-time sign-in link and open it in your browser.
rem Needs Docker Desktop running. Everything uses the fake Claude (no network, no tokens) unless ANTHROPIC_API_KEY and
rem CLAUDE_BACKEND=sdk are set in this window first. See docs\DOCKER.md.
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 goto nodocker
docker info >nul 2>nul
if errorlevel 1 goto nodaemon

echo Building and starting the Mira backend in Docker (the first build takes a few minutes)...
docker compose up -d --build
if errorlevel 1 goto failed
rem The sign-in code is single use and is made when the daemon starts, so start it once more to get a fresh link.
docker compose restart daemon >nul
if errorlevel 1 goto failed

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-link.ps1"
if errorlevel 1 goto failed

echo.
echo The backend keeps running in Docker. Stop it with: docker compose down   (your data stays in the mira-data volume)
echo To connect Unity, print the stage token with: docker compose exec daemon node --import tsx src/stage/cli.ts token
pause
exit /b 0

:nodocker
echo Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/
pause
exit /b 1

:nodaemon
echo Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then run this again.
pause
exit /b 1

:failed
echo Something failed. Copy the error text above.
pause
exit /b 1
