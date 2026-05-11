param(
    [string] $Version = "0.2.0",
    [string] $Repository = "TheRofli/Quokka",
    [string] $InstallerPath = "",
    [switch] $RebuildInstaller,
    [switch] $Draft
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
$token = $env:GITHUB_TOKEN
if (-not $token) {
    $token = $env:GH_TOKEN
}
if (-not $token) {
    throw "Set GITHUB_TOKEN or GH_TOKEN before publishing a GitHub Release."
}

Push-Location $Root
try {
    if ($RebuildInstaller) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\build-windows-installer.ps1")
    }

    if (-not $InstallerPath) {
        $InstallerPath = Get-ChildItem (Join-Path $Root "desktop\release") -Filter "Quokka Setup *.exe" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) {
        throw "Installer was not found. Build it first with scripts\build-windows-installer.ps1."
    }

    $status = git status --porcelain
    if ($status) {
        throw "Working tree is not clean. Commit changes before publishing $tag."
    }

    if (-not (git rev-parse $tag 2>$null)) {
        git tag -a $tag -m "Quokka $tag"
    }
    git push origin main
    git push origin $tag

    $headers = @{
        Authorization = "Bearer $token"
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
    }
    $apiBase = "https://api.github.com/repos/$Repository"
    try {
        $release = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/tags/$tag" -Headers $headers
    }
    catch {
        $body = @{
            tag_name = $tag
            name = "Quokka $tag"
            body = "Windows installer for Quokka $tag.`n`nInstall once, then Quokka can show future update notices from GitHub Releases."
            draft = [bool]$Draft
            prerelease = $false
        } | ConvertTo-Json
        $release = Invoke-RestMethod -Method Post -Uri "$apiBase/releases" -Headers $headers -ContentType "application/json" -Body $body
    }

    $assetName = Split-Path $InstallerPath -Leaf
    foreach ($asset in @($release.assets)) {
        if ($asset.name -eq $assetName) {
            Invoke-RestMethod -Method Delete -Uri "$apiBase/releases/assets/$($asset.id)" -Headers $headers | Out-Null
        }
    }

    $uploadUrl = ($release.upload_url -replace "\{.*$", "")
    $encodedAssetName = [uri]::EscapeDataString($assetName)
    Invoke-RestMethod `
        -Method Post `
        -Uri "${uploadUrl}?name=$encodedAssetName" `
        -Headers $headers `
        -ContentType "application/octet-stream" `
        -InFile $InstallerPath | Out-Null

    Write-Host "Published $tag with asset: $assetName"
    Write-Host $release.html_url
}
finally {
    Pop-Location
}
