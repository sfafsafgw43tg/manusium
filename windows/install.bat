@echo off
rem install.bat
rem Installs OctoSuite. Two cases, detected automatically:
rem   * a release installer next to the scripts -> verify (SHA-256, Ed25519, Authenticode) and run it;
rem   * a source checkout (this repository)     -> install Node.js/git and build the Electron
rem                                                application; Chromium source compilation is
rem                                                reserved for the developer/CI build workflow.
rem Convenience forwarder for the repository root - all logic lives in scripts\install.bat.
rem Use install.bat -Background for a complete hidden setup; progress is written to the installer log.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\install.bat" (
  echo Missing file: %~dp0scripts\install.bat
  exit /b 1
)
call "%~dp0scripts\install.bat" %*
endlocal & exit /b %ERRORLEVEL%
