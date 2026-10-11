@echo off
rem scripts\setup.bat
rem Installs everything OctoSuite needs to run from sources: Node.js (>= 22.12) and git
rem through winget (only after your confirmation), then "npm ci" and "npm run build".
rem Same as install.bat when there is no release installer next to the scripts.
rem Options: -Yes (no questions), -Lang en|pl.
rem
rem Thin wrapper: all logic is in lib\octo.ps1 (Windows PowerShell 5.1, built into Windows 10/11).
rem Paths with spaces and Polish characters are safe: %~dp0 is always quoted and
rem delayed expansion is disabled (so "!" in folder names is not touched).
rem Extra arguments are passed through, e.g.:  setup.bat -Yes
setlocal EnableExtensions DisableDelayedExpansion
rem Remember the console code page, switch to UTF-8 for PowerShell output, restore at the end.
set "OCTO_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "OCTO_CP=%%a"
chcp 65001 >nul 2>&1
set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
"%OCTO_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\octo.ps1" setup %*
set "OCTO_RC=%ERRORLEVEL%"
if defined OCTO_CP chcp %OCTO_CP% >nul 2>&1
if not defined OCTO_NOPAUSE pause
endlocal & exit /b %OCTO_RC%
