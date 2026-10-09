@echo off
rem install.bat
rem Installs OctoSuite. Two cases, detected automatically:
rem   * a release installer next to the scripts -> verify (SHA-256, Ed25519, Authenticode) and run it;
rem   * a source checkout (this repository)     -> install Node.js/git with winget when missing,
rem                                                offer the Android prerequisites (Android Studio,
rem                                                Python, OBS virtual camera, VB-CABLE microphone)
rem                                                then "npm ci" and "npm run build".
rem Convenience forwarder for the repository root - all logic lives in scripts\install.bat.
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\install.bat" (
  echo Missing file: %~dp0scripts\install.bat
  exit /b 1
)
call "%~dp0scripts\install.bat" %*
endlocal & exit /b %ERRORLEVEL%
