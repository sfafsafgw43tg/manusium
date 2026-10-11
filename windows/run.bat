@echo off
rem run.bat
rem Starts Octo.su and OctoDetect.su WITHOUT a console window.
rem On the first run from sources everything missing is installed first (see install.bat).
rem Convenience forwarder for the repository root - all logic lives in scripts\run.bat;
rem the window is hidden here as well so double-clicking this file shows no console at all.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\run.bat" (
  echo Missing file: %~dp0scripts\run.bat
  exit /b 1
)
if not defined OCTO_HIDDEN (
  if exist "%SystemRoot%\System32\wscript.exe" (
    if exist "%~dp0scripts\lib\hidden.vbs" (
      start "" /b "%SystemRoot%\System32\wscript.exe" //nologo //B "%~dp0scripts\lib\hidden.vbs" "%~dp0scripts\run.bat" %*
      endlocal & exit /b 0
    )
  )
)
call "%~dp0scripts\run.bat" %*
endlocal & exit /b %ERRORLEVEL%
