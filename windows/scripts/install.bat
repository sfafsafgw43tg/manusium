@echo off
rem scripts\install.bat
rem Verifies (SHA-256, Authenticode, Ed25519 manifest) and runs OctoSuite-Setup-*.exe. Option: -Source <folder>.
rem In a source checkout it installs only the prerequisites required for the Chromium source build
rem and application. Android/media prerequisites and Firefox staging are separate feature flows.
rem
rem Thin wrapper: all logic is in lib\octo.ps1 (Windows PowerShell 5.1, built into Windows 10/11).
rem Paths with spaces and Polish characters are safe: %~dp0 is always quoted and
rem delayed expansion is disabled (so "!" in folder names is not touched).
rem The installation is unattended: no y/N questions. A small window shows the
rem progress, the current step, an ETA and lets you pick the folder for the
rem Android SDK and its system images.
rem Extra arguments are passed through:
rem   install.bat -NoGui        run in this console instead of the window
rem   install.bat -Interactive  ask the old y/N questions again
rem   install.bat -Background   run the complete setup hidden; inspect %LOCALAPPDATA%\InkBrowser\logs\ for progress
rem The first invocation requests UAC once. The elevated child carries -Elevated through
rem the rest of setup so Visual Studio and driver installation do not prompt again.
setlocal EnableExtensions DisableDelayedExpansion
set "OCTO_ELEVATED="
echo %* | find /i "-elevated" >nul 2>&1 && set "OCTO_ELEVATED=1"
if not defined OCTO_ELEVATED (
  set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
  "%OCTO_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\elevate-installer.ps1" -BatchPath "%~f0" -WorkingDirectory "%~dp0.." -Arguments "__OCTO_NO_ARGS__" %*
  set "OCTO_RC=%ERRORLEVEL%"
  endlocal & exit /b %OCTO_RC%
)
rem Classic installer behavior: a normal double-click keeps this console visible so
rem the user can see UAC, progress, errors and the final result. Only an explicit
rem -Background request uses the hidden launcher; -NoGui and -Interactive remain visible.
set "OCTO_WANTS_CONSOLE="
echo %* | find /i "-nogui" >nul 2>&1 && set "OCTO_WANTS_CONSOLE=1"
echo %* | find /i "-interactive" >nul 2>&1 && set "OCTO_WANTS_CONSOLE=1"
set "OCTO_WANTS_BACKGROUND="
echo %* | find /i "-background" >nul 2>&1 && set "OCTO_WANTS_BACKGROUND=1"
if defined OCTO_WANTS_BACKGROUND if not defined OCTO_WANTS_CONSOLE (
  if not defined OCTO_HIDDEN if exist "%SystemRoot%\System32\wscript.exe" if exist "%~dp0lib\hidden.vbs" (
    start "" /b "%SystemRoot%\System32\wscript.exe" //nologo //B "%~dp0lib\hidden.vbs" "%~f0" %*
    endlocal & exit /b 0
  )
)
rem Remember the console code page, switch to UTF-8 for PowerShell output, restore at the end.
set "OCTO_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "OCTO_CP=%%a"
chcp 65001 >nul 2>&1
set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
"%OCTO_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\octo.ps1" install %*
set "OCTO_RC=%ERRORLEVEL%"
if defined OCTO_CP chcp %OCTO_CP% >nul 2>&1
if not defined OCTO_NOPAUSE pause
endlocal & exit /b %OCTO_RC%
