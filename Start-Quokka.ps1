$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Desktop = Join-Path $Root "desktop"
$Frontend = Join-Path $Root "frontend"

if (-not (Test-Path (Join-Path $Desktop "package.json"))) {
    throw "Quokka desktop folder was not found."
}

if (-not (Test-Path (Join-Path $Frontend "dist\index.html"))) {
    Write-Host "Building Quokka frontend..."
    Push-Location $Frontend
    try {
        npm install --cache .npm-cache
        npm run build
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $Desktop "node_modules\electron\cli.js"))) {
    Write-Host "Installing Quokka desktop dependencies..."
    Push-Location $Desktop
    try {
        npm install --cache .npm-cache
    }
    finally {
        Pop-Location
    }
}

$Node = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (-not (Test-Path $Node)) {
    $Node = "node"
}

Start-Process -FilePath $Node `
    -ArgumentList @((Join-Path $Desktop "node_modules\electron\cli.js"), $Desktop) `
    -WorkingDirectory $Desktop
