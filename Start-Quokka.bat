@echo off
setlocal

set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%Start-Quokka.ps1"

if errorlevel 1 (
  echo.
  echo Quokka failed to start.
  pause
)

exit /b %errorlevel%
