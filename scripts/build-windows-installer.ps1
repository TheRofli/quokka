param(
    [switch] $SkipBackendSidecar
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Push-Location $Root
try {
    Write-Host "Building frontend..."
    Push-Location (Join-Path $Root "frontend")
    try {
        npm install --cache .npm-cache
        npm run build
    }
    finally {
        Pop-Location
    }

    if (-not $SkipBackendSidecar) {
        Write-Host "Building backend sidecar..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "desktop\scripts\build-backend-sidecar.ps1")
    }

    Write-Host "Building Electron NSIS installer..."
    Push-Location (Join-Path $Root "desktop")
    try {
        npm install --cache .npm-cache
        npm run build
    }
    finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "Installer output:"
    Get-ChildItem (Join-Path $Root "desktop\release") -Filter "*.exe" | Select-Object FullName, Length, LastWriteTime
}
finally {
    Pop-Location
}
