param(
    [string] $RepoUrl = "https://github.com/TheRofli/Quokka.git",
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA "Quokka\app"),
    [switch] $NoLaunch
)

$script = Join-Path $PSScriptRoot "install.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $script -RepoUrl $RepoUrl -InstallDir $InstallDir -NoLaunch:$NoLaunch
