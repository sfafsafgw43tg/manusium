@echo off
rem install.bat
rem Installs OctoSuite. Two cases, detected automatically:
rem   * a release installer next to the scripts -> verify (SHA-256, Ed25519, Authenticode) and run it;
rem   * a source checkout (this repository)     -> install the Node.js/git and Chromium build
rem                                                prerequisites when missing, then build the
rem                                                source-based Chromium runtime and application.
rem Convenience forwarder for the repository root - all logic lives in scripts\install.bat.
rem Use install.bat -Background for a complete hidden setup; progress is written to the installer log.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\install.bat" (
  echo Missing file: %~dp0scripts\install.bat
  exit /b 1
)
call "%~dp0scripts\install.bat" %*
endlocal & exit /b %ERRORLEVEL%
