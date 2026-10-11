@echo off
rem scripts\update.bat
rem Checks the official GitHub release, verifies, backs up configuration and installs the update. Option: -CheckOnly.
rem
rem Thin wrapper: all logic is in lib\octo.ps1 (Windows PowerShell 5.1, built into Windows 10/11).
rem Paths with spaces and Polish characters are safe: %~dp0 is always quoted and
rem delayed expansion is disabled (so "!" in folder names is not touched).
rem Extra arguments are passed through, e.g.:  update.bat -Yes
setlocal EnableExtensions DisableDelayedExpansion
rem Remember the console code page, switch to UTF-8 for PowerShell output, restore at the end.
set "OCTO_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "OCTO_CP=%%a"
chcp 65001 >nul 2>&1
set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
"%OCTO_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\octo.ps1" update %*
set "OCTO_RC=%ERRORLEVEL%"
if defined OCTO_CP chcp %OCTO_CP% >nul 2>&1
if not defined OCTO_NOPAUSE pause
endlocal & exit /b %OCTO_RC%
