@echo off
rem scripts\start-all.bat
rem Updates from GitHub (same check as github-update.bat) and then starts BOTH applications:
rem Octo.su and OctoDetect.su. A failed or declined update never blocks the start.
rem Options: -NoUpdate (start without checking), -Yes (no questions), -Lang en|pl.
rem
rem Thin wrapper: all logic is in lib\octo.ps1 (Windows PowerShell 5.1, built into Windows 10/11).
rem Paths with spaces and Polish characters are safe: %~dp0 is always quoted and
rem delayed expansion is disabled (so "!" in folder names is not touched).
rem Extra arguments are passed through, e.g.:  start-all.bat -NoUpdate
setlocal EnableExtensions DisableDelayedExpansion
rem Remember the console code page, switch to UTF-8 for PowerShell output, restore at the end.
set "OCTO_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "OCTO_CP=%%a"
chcp 65001 >nul 2>&1
set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
"%OCTO_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\octo.ps1" start-all %*
set "OCTO_RC=%ERRORLEVEL%"
if defined OCTO_CP chcp %OCTO_CP% >nul 2>&1
if not defined OCTO_NOPAUSE pause
endlocal & exit /b %OCTO_RC%
