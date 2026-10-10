@echo off
rem scripts\install.bat
rem Verifies (SHA-256, Authenticode, Ed25519 manifest) and runs OctoSuite-Setup-*.exe. Option: -Source <folder>.
rem In a source checkout it also installs the prerequisites: Node.js/git, and - after a confirmation -
rem Android Studio, Python 3, OBS Studio and VB-CABLE, which the Android devices section and the
rem bundled vStudio virtual camera/microphone need.
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
setlocal EnableExtensions DisableDelayedExpansion
rem The graphical installer needs no console at all, so the first pass
rem re-launches this file through lib\hidden.vbs (Windows Script Host, window
rem style 0) and exits at once - exactly what run.bat does. The console stays
rem visible for -NoGui and -Interactive, and if Windows Script Host is disabled
rem by policy everything simply runs in this window instead of failing.
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
if not defined OCTO_WANTS_CONSOLE (
  if not defined OCTO_HIDDEN (
    if exist "%SystemRoot%\System32\wscript.exe" (
      if exist "%~dp0lib\hidden.vbs" (
        start "" /b "%SystemRoot%\System32\wscript.exe" //nologo //B "%~dp0lib\hidden.vbs" "%~f0" %*
        endlocal & exit /b 0
      )
    )
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
