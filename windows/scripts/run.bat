@echo off
rem scripts\run.bat
rem Starts Octo.su and OctoDetect.su WITHOUT a console window.
rem First run from sources also installs everything that is missing (see install.bat).
rem Options: -Update (fast-forward the sources from GitHub first), -Lang en|pl.
rem
rem How the console is hidden: the first pass re-launches this same file through
rem lib\hidden.vbs (Windows Script Host, window style 0) and exits immediately, so no
rem window is ever shown. If Windows Script Host is disabled by policy, the script keeps
rem working in a normal console instead of failing.
setlocal EnableExtensions DisableDelayedExpansion
set "OCTO_NOPAUSE=1"
if not defined OCTO_HIDDEN (
  if exist "%SystemRoot%\System32\wscript.exe" (
    if exist "%~dp0lib\hidden.vbs" (
      start "" /b "%SystemRoot%\System32\wscript.exe" //nologo //B "%~dp0lib\hidden.vbs" "%~f0" %*
      endlocal & exit /b 0
    )
  )
)
set "OCTO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%OCTO_PS%" set "OCTO_PS=powershell.exe"
"%OCTO_PS%" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0lib\octo.ps1" run %*
endlocal & exit /b %ERRORLEVEL%
