@echo off
rem start.bat
rem Starts OctoSuite (Octo.su and OctoDetect.su).
rem Convenience forwarder to run.bat.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0run.bat" (
  echo Missing file: %~dp0run.bat
  exit /b 1
)
call "%~dp0run.bat" %*
endlocal & exit /b %ERRORLEVEL%
