param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"

$DesktopRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $DesktopRoot
$BackendRoot = Join-Path $ProjectRoot "backend"
$OutputRoot = Join-Path $DesktopRoot "resources\backend"
$WorkRoot = Join-Path $DesktopRoot ".pyinstaller"

if ([string]::IsNullOrWhiteSpace($Python)) {
    $Python = Join-Path $BackendRoot ".venv\Scripts\python.exe"
}

if (-not (Test-Path $Python)) {
    throw "Python interpreter not found at '$Python'. Create backend\.venv first or pass -Python."
}

Push-Location $BackendRoot
try {
    & $Python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install PyInstaller."
    }

    & $Python -m PyInstaller `
        --clean `
        --noconfirm `
        --name quokka-backend `
        --onefile `
        --distpath $OutputRoot `
        --workpath $WorkRoot `
        --specpath $WorkRoot `
        --collect-all fastapi `
        --collect-all uvicorn `
        --collect-all pydantic `
        --collect-all starlette `
        app\desktop_entry.py
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed to build the backend sidecar."
    }
}
finally {
    Pop-Location
}

Write-Host "Backend sidecar built at $OutputRoot\quokka-backend.exe"
