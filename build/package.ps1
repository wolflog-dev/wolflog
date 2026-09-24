<#
.SYNOPSIS
    Construit les livrables de Vigil dans dist/ :
      vigil-linux-x64.tar.gz, vigil-linux-arm64.tar.gz  (binaire unique + install.sh)
      vigil-win-x64.zip                                 (IIS ou service Windows)
      nuget/Vigil.Client.*.nupkg, Vigil.Client.Serilog.*.nupkg, Vigil.Protocol.*.nupkg

.EXAMPLE
    ./build/package.ps1
    ./build/package.ps1 -Version 0.2.0 -SkipTests
#>
[CmdletBinding()]
param(
    [string] $Version = '',
    [switch] $SkipUi,
    [switch] $SkipTests,
    [string[]] $Runtimes = @('linux-x64', 'linux-arm64', 'win-x64')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
Set-Location $root

function Run($exe) {
    # stderr des outils natifs : pas une erreur PowerShell (seul le code de sortie compte).
    $ErrorActionPreference = 'Continue'
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$exe $args : code $LASTEXITCODE" }
}

$versionArgs = @()
if ($Version) { $versionArgs = @("-p:Version=$Version") }

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null

if (-not $SkipUi) {
    Write-Host '== Interface (Angular)'
    # npm.cmd plutôt que npm.ps1 : code de sortie fiable sous Windows PowerShell 5.1.
    $npm = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }
    Push-Location ui
    try {
        if (-not (Test-Path node_modules)) { Run $npm ci --no-audit --no-fund }
        Run $npm run build
    } finally { Pop-Location }
}

if (-not $SkipTests) {
    Write-Host '== Tests'
    Run dotnet test --project tests/Vigil.Tests
}

foreach ($rid in $Runtimes) {
    Write-Host "== Serveur $rid"
    $name = "vigil-$rid"
    $out = Join-Path $dist $name
    $common = @('publish', 'src/Vigil.Server', '-c', 'Release', '-r', $rid, '--self-contained', '-o', $out,
                '-p:SkipUi=true', '-p:DebugType=none', '-p:GenerateDocumentationFile=false') + $versionArgs

    $cleanup = { Remove-Item (Join-Path $out 'appsettings.Development.json'), (Join-Path $out '*.staticwebassets.*.json') -ErrorAction SilentlyContinue }
    if ($rid -like 'win-*') {
        # Dossier classique : requis par IIS (hébergement in-process), fonctionne aussi en service Windows.
        Run dotnet @common
        & $cleanup
        Copy-Item deploy/iis/install-iis.ps1, deploy/windows/install-service.cmd, README.md $out
        Compress-Archive -Path "$out/*" -DestinationPath (Join-Path $dist "$name.zip") -CompressionLevel Optimal
    } else {
        # Binaire unique (runtime .NET, DuckDB et interface inclus).
        Run dotnet @common -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true
        Remove-Item (Join-Path $out 'web.config') -ErrorAction SilentlyContinue
        & $cleanup
        Copy-Item deploy/linux/install.sh, deploy/linux/uninstall.sh, README.md $out
        Run dotnet run build/targz.cs -- $out (Join-Path $dist "$name.tar.gz")
    }
}

Write-Host '== Paquets NuGet'
foreach ($p in 'src/Vigil.Protocol', 'src/Vigil.Client', 'src/Vigil.Client.Serilog') {
    Run dotnet pack $p -c Release -o (Join-Path $dist 'nuget') @versionArgs
}

Write-Host ''
Get-ChildItem $dist -File -Recurse -Include *.zip, *.tar.gz, *.nupkg |
    ForEach-Object { '{0,-60} {1,8:N1} Mo' -f $_.FullName.Substring($dist.Length + 1), ($_.Length / 1MB) }
