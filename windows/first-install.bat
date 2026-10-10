@echo off
rem first-install.bat
rem Complete first-time setup for OctoSuite on new PCs.
rem Installs all prerequisites (Node.js >= 22.12, git, Python 3, Android tools,
rem OBS virtual camera, VB-CABLE), builds dependencies ("npm install" / "npm ci",
rem "npm run build"), creates desktop shortcuts, and prepares the browser.
rem Convenience forwarder for the repository root - all logic lives in scripts\first-install.bat.
rem Use first-install.bat -Background for a complete hidden setup; progress is written to the installer log.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\first-install.bat" (
  echo Missing file: %~dp0scripts\first-install.bat
  exit /b 1
)
set "OCTO_WANTS_CONSOLE="
echo %* | find /i "-nogui" >nul 2>&1 && set "OCTO_WANTS_CONSOLE=1"
echo %* | find /i "-interactive" >nul 2>&1 && set "OCTO_WANTS_CONSOLE=1"
if not defined OCTO_WANTS_CONSOLE (
  if not defined OCTO_HIDDEN (
    if exist "%SystemRoot%\System32\wscript.exe" (
      if exist "%~dp0scripts\lib\hidden.vbs" (
        start "" /b "%SystemRoot%\System32\wscript.exe" //nologo //B "%~dp0scripts\lib\hidden.vbs" "%~dp0scripts\first-install.bat" %*
        endlocal & exit /b 0
      )
    )
  )
)
call "%~dp0scripts\first-install.bat" %*
endlocal & exit /b %ERRORLEVEL%
