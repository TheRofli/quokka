param(
    [string] $Version = "0.2.0",
    [switch] $Push
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }

Push-Location $Root
try {
    $status = git status --porcelain
    if ($status) {
        throw "Working tree is not clean. Commit or stash changes before creating $tag."
    }

    Write-Host "Running backend compile check..."
    Push-Location (Join-Path $Root "backend")
    try {
        $python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
        if (-not (Test-Path $python)) {
            $python = "python"
        }
        & $python -m compileall app
    }
    finally {
        Pop-Location
    }

    Write-Host "Running frontend build..."
    Push-Location (Join-Path $Root "frontend")
    try {
        npm run build
    }
    finally {
        Pop-Location
    }

    if (git rev-parse $tag 2>$null) {
        throw "Tag $tag already exists."
    }

    git tag -a $tag -m "Quokka $tag"
    Write-Host "Created tag $tag."

    if ($Push) {
        git push origin main
        git push origin $tag
        Write-Host "Pushed main and $tag."
    }
    else {
        Write-Host "Tag is local. Push it with: git push origin main $tag"
    }
}
finally {
    Pop-Location
}
