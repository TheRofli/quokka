param(
    [switch] $SetupOnly,
    [switch] $ForceBuild
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Desktop = Join-Path $Root "desktop"
$Frontend = Join-Path $Root "frontend"
$BackendPort = 8000

function Test-PathStartsWith {
    param(
        [string] $PathValue,
        [string] $Prefix
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $false
    }

    return $PathValue.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Require-Command {
    param(
        [string] $Name,
        [string] $Message
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw $Message
    }
}

function Ensure-QuokkaConfig {
    $configDir = Join-Path $Backend "config"
    $configPath = Join-Path $configDir "quokka.yaml"
    $examplePath = Join-Path $configDir "quokka.example.yaml"

    if (Test-Path $configPath) {
        return
    }

    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    if (Test-Path $examplePath) {
        Copy-Item -LiteralPath $examplePath -Destination $configPath
    }
    else {
        @"
app_name: Quokka
version: 0.1.0
refresh_interval_seconds: 5
models: []
"@ | Set-Content -Path $configPath -Encoding UTF8
    }
}

function Ensure-Backend {
    if (-not (Test-Path (Join-Path $Backend "requirements.txt"))) {
        throw "Quokka backend requirements file was not found."
    }

    $venvPython = Join-Path $Backend ".venv\Scripts\python.exe"
    if (-not (Test-Path $venvPython)) {
        Require-Command "python" "Python 3.11+ was not found. Install Python and enable 'Add python.exe to PATH'."
        Write-Host "Creating Quokka backend Python environment..."
        Push-Location $Backend
        try {
            python -m venv .venv
        }
        finally {
            Pop-Location
        }
    }

    $installMarker = Join-Path $Backend ".venv\.quokka-requirements-installed"
    if (-not (Test-Path $installMarker) -or $ForceBuild) {
        Write-Host "Installing Quokka backend dependencies..."
        Push-Location $Backend
        try {
            $env:PYTHONIOENCODING = "utf-8"
            $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
            & $venvPython -m pip install --disable-pip-version-check --no-color --progress-bar off -r requirements.txt
            Set-Content -Path $installMarker -Value (Get-Date).ToString("o") -Encoding ASCII
        }
        finally {
            Pop-Location
        }
    }
}

function Ensure-Frontend {
    if (-not (Test-Path (Join-Path $Frontend "package.json"))) {
        throw "Quokka frontend folder was not found."
    }

    Push-Location $Frontend
    try {
        if (-not (Test-Path "node_modules") -or $ForceBuild) {
            Write-Host "Installing Quokka frontend dependencies..."
            npm install --cache .npm-cache
        }

        if (-not (Test-Path "dist\index.html") -or $ForceBuild) {
            Write-Host "Building Quokka frontend..."
            npm run build
        }
    }
    finally {
        Pop-Location
    }
}

function Ensure-Desktop {
    if (-not (Test-Path (Join-Path $Desktop "package.json"))) {
        throw "Quokka desktop folder was not found."
    }

    if (-not (Test-Path (Join-Path $Desktop "node_modules\electron\cli.js")) -or $ForceBuild) {
        Write-Host "Installing Quokka desktop dependencies..."
        Push-Location $Desktop
        try {
            npm install --cache .npm-cache
        }
        finally {
            Pop-Location
        }
    }
}

function Stop-ExistingQuokka {
    Write-Host "Stopping existing Quokka session if one is still alive..."

    $desktopPath = (Resolve-Path $Desktop).Path
    Get-Process -Name "electron" -ErrorAction SilentlyContinue |
        Where-Object { Test-PathStartsWith $_.Path $desktopPath } |
        Stop-Process -Force -ErrorAction SilentlyContinue

    try {
        $listeners = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
        foreach ($listener in $listeners) {
            try {
                $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
                $isQuokkaBackend = (Test-PathStartsWith $process.Path $Root) -or $process.ProcessName -in @("python", "quokka-backend")
                if ($isQuokkaBackend) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                }
            }
            catch {
                # Best-effort cleanup. If Windows denies access, Electron will reuse the running backend.
            }
        }
    }
    catch {
        # Get-NetTCPConnection can be unavailable on older Windows builds.
    }
}

Require-Command "node" "Node.js was not found. Install Node.js LTS from https://nodejs.org/."
Require-Command "npm" "npm was not found. Install Node.js LTS from https://nodejs.org/."

Ensure-QuokkaConfig
Ensure-Backend
Ensure-Frontend
Ensure-Desktop

if ($SetupOnly) {
    Write-Host "Quokka setup complete."
    exit 0
}

Stop-ExistingQuokka

$Node = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (-not (Test-Path $Node)) {
    $Node = "node"
}

Write-Host "Starting Quokka..."
$ElectronCli = Join-Path $Desktop "node_modules\electron\cli.js"
$ElectronArguments = "`"$ElectronCli`" `"$Desktop`""
Start-Process -FilePath $Node `
    -ArgumentList $ElectronArguments `
    -WorkingDirectory $Desktop
