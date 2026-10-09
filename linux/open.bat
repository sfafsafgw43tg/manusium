@echo off
rem open.bat
rem Starts Octo.su. Convenience forwarder to scripts\open.bat.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\open.bat" (
  echo Missing file: %~dp0scripts\open.bat
  exit /b 1
)
call "%~dp0scripts\open.bat" %*
endlocal & exit /b %ERRORLEVEL%
