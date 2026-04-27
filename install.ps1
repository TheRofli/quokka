param(
    [string] $RepoUrl = "https://github.com/TheRofli/Quokka.git",
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA "Quokka\app"),
    [switch] $NoLaunch
)

$ErrorActionPreference = "Stop"

function Require-Command {
    param(
        [string] $Name,
        [string] $InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $InstallHint"
    }
}

function Add-UserPath {
    param([string] $PathToAdd)

    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        $entries = $current -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    if ($entries -notcontains $PathToAdd) {
        $next = (@($entries) + $PathToAdd) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $next, "User")
        $env:Path = "$env:Path;$PathToAdd"
    }
}

Write-Host "Quokka installer"
Write-Host "Repository: $RepoUrl"
Write-Host "Install dir: $InstallDir"

Require-Command "git" "Install Git for Windows: https://git-scm.com/download/win"
Require-Command "node" "Install Node.js LTS: https://nodejs.org/"
Require-Command "npm" "Install Node.js LTS: https://nodejs.org/"
Require-Command "python" "Install Python 3.11+ and enable 'Add python.exe to PATH'."

$installParent = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Force -Path $installParent | Out-Null

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating existing Quokka checkout..."
    git -C $InstallDir pull --ff-only
}
elseif (Test-Path $InstallDir) {
    throw "Install dir already exists but is not a git checkout: $InstallDir"
}
else {
    Write-Host "Cloning Quokka..."
    git clone $RepoUrl $InstallDir
}

$startScript = Join-Path $InstallDir "Start-Quokka.ps1"
if (-not (Test-Path $startScript)) {
    throw "Start-Quokka.ps1 was not found after clone."
}

Write-Host "Preparing dependencies..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $startScript -SetupOnly

$binDir = Join-Path $env:LOCALAPPDATA "Quokka\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdPath = Join-Path $binDir "quokka.cmd"
$cmdContent = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$startScript" %*
"@
Set-Content -Path $cmdPath -Value $cmdContent -Encoding ASCII

Add-UserPath $binDir

Write-Host ""
Write-Host "Quokka installed."
Write-Host "Command: quokka"
Write-Host "If this terminal does not see 'quokka', open a new terminal window."

if (-not $NoLaunch) {
    Write-Host "Launching Quokka..."
    & $cmdPath
}
