@echo off
rem Move Mira into one common folder for VS Code and bring over your existing Unity work (docs\MIGRATION.md).
rem Double-click: it asks for the folder of your Unity work. Or from a terminal, for example:
rem   migrate.cmd -OldClone C:\dev\ai_assistant        (an older clone where the Unity project was built)
rem   migrate.cmd -UnityProject D:\Unity\MiraRoom      (a Unity project folder somewhere else)
rem   migrate.cmd -DryRun                              (only report what it would do)
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\migrate.ps1" %*
set code=%errorlevel%
echo.
if "%code%"=="0" (echo Done.) else (echo Finished with exit code %code%. The lines marked [fail] or [todo] say what is left.)
pause
exit /b %code%
