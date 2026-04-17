@echo off
setlocal

set "ROOT=%~dp0"
set "DESKTOP=%ROOT%desktop"
set "FRONTEND=%ROOT%frontend"

if not exist "%DESKTOP%\package.json" (
  echo Quokka desktop folder was not found.
  pause
  exit /b 1
)

if not exist "%FRONTEND%\dist\index.html" (
  echo Building Quokka frontend...
  pushd "%FRONTEND%"
  call npm install --cache .npm-cache
  if errorlevel 1 (
    popd
    echo Failed to install frontend dependencies.
    pause
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    popd
    echo Failed to build frontend.
    pause
    exit /b 1
  )
  popd
)

if not exist "%DESKTOP%\node_modules\electron\cli.js" (
  echo Installing Quokka desktop dependencies...
  pushd "%DESKTOP%"
  call npm install --cache .npm-cache
  if errorlevel 1 (
    popd
    echo Failed to install desktop dependencies.
    pause
    exit /b 1
  )
  popd
)

start "Quokka" /D "%DESKTOP%" "%ProgramFiles%\nodejs\node.exe" "%DESKTOP%\node_modules\electron\cli.js" "%DESKTOP%"
exit /b 0

