<#
.SYNOPSIS
    Installe (ou met à jour) Vigil sous IIS.

.DESCRIPTION
    À lancer depuis le dossier extrait de vigil-win-x64.zip, dans un PowerShell administrateur :

        .\install-iis.ps1
        .\install-iis.ps1 -Port 8080 -HostName vigil.mondomaine.fr
        .\install-iis.ps1 -InstallHostingBundle -EnableIis   # serveur vierge

    Le script :
      - vérifie IIS et le module ASP.NET Core (Hosting Bundle), et peut les installer ;
      - copie les fichiers dans -InstallDir (la configuration et les données existantes sont conservées) ;
      - crée le pool d'applications (toujours démarré, sans recyclage avec chevauchement) et le site ;
      - donne au pool les droits d'écriture sur le dossier de données ;
      - génère le mot de passe administrateur et la clé API au premier lancement, et les affiche.

.NOTES
    Sous IIS, l'OTLP passe par HTTP sur le port du site (/v1/logs, /v1/traces, /v1/metrics).
    L'OTLP gRPC (port 4317) n'est disponible qu'avec le service Windows ou Linux.
#>
[CmdletBinding()]
param(
    [string] $SiteName = 'Vigil',
    [int] $Port = 5080,
    [string] $HostName = '',
    [string] $InstallDir = 'C:\inetpub\vigil',
    [string] $DataDir = (Join-Path $env:ProgramData 'Vigil'),
    [switch] $InstallHostingBundle,
    [switch] $EnableIis
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

function Step($text) { Write-Host "-> $text" }

# --- Prérequis ---------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Lancez ce script dans un PowerShell 'Exécuter en tant qu'administrateur'."
}
if (-not (Test-Path (Join-Path $source 'vigil.exe'))) {
    throw "vigil.exe introuvable à côté du script. Lancez-le depuis le dossier extrait de vigil-win-x64.zip."
}

if (-not (Get-Service W3SVC -ErrorAction SilentlyContinue)) {
    if (-not $EnableIis) { throw "IIS n'est pas installé. Relancez avec -EnableIis pour l'activer." }
    Step "Activation d'IIS"
    if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
        Install-WindowsFeature Web-Server, Web-WebSockets -IncludeManagementTools | Out-Null
    } else {
        Enable-WindowsOptionalFeature -Online -NoRestart -FeatureName IIS-WebServerRole, IIS-WebServer, IIS-ManagementConsole | Out-Null
    }
}

$ancm = Join-Path $env:ProgramFiles 'IIS\Asp.Net Core Module\V2\aspnetcorev2.dll'
if (-not (Test-Path $ancm)) {
    if (-not $InstallHostingBundle) {
        throw "Le module ASP.NET Core pour IIS est absent. Relancez avec -InstallHostingBundle, ou installez le 'Hosting Bundle' .NET depuis https://dotnet.microsoft.com/download/dotnet"
    }
    Step "Téléchargement et installation du Hosting Bundle .NET (Microsoft)"
    $installer = Join-Path $env:TEMP 'dotnet-hosting-bundle.exe'
    Invoke-WebRequest -UseBasicParsing 'https://dotnet.microsoft.com/permalink/dotnetcore-current-windows-runtime-bundle-installer' -OutFile $installer
    $sig = Get-AuthenticodeSignature $installer
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') { throw "Signature du Hosting Bundle invalide." }
    Start-Process $installer -ArgumentList '/install', '/quiet', '/norestart' -Wait
    & net stop was /y | Out-Null
    & net start w3svc | Out-Null
}

$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
function AppCmd { & $appcmd @args; if ($LASTEXITCODE -ne 0) { throw "appcmd $args (code $LASTEXITCODE)" } }
function Exists($kind, $name) {
    $out = & $appcmd list $kind /name:"$name" 2>$null
    return ($LASTEXITCODE -eq 0) -and [bool]$out
}

# --- Fichiers ----------------------------------------------------------------
$siteExists = Exists 'site' $SiteName
if ($siteExists) {
    Step "Arrêt du site existant (mise à jour)"
    & $appcmd stop site /site.name:"$SiteName" | Out-Null
    & $appcmd stop apppool /apppool.name:"$SiteName" | Out-Null
    Start-Sleep -Seconds 3
}

Step "Copie des fichiers vers $InstallDir"
New-Item -ItemType Directory -Force $InstallDir | Out-Null
# /XF : on ne remplace jamais la configuration locale.
& robocopy $source $InstallDir /E /NFL /NDL /NJH /NJS /NP /XF vigil.json install-iis.ps1 /XD data logs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Échec de la copie (robocopy code $LASTEXITCODE)" }
New-Item -ItemType Directory -Force (Join-Path $InstallDir 'logs'), $DataDir | Out-Null

# --- Configuration (identifiants générés au premier lancement) ---------------
Step "Configuration"
$init = & (Join-Path $InstallDir 'vigil.exe') init --data $DataDir --port $Port --quiet
if ($LASTEXITCODE -ne 0) { throw "vigil init a échoué : $init" }
$password, $apiKey = $init

# --- IIS ---------------------------------------------------------------------
if (-not (Exists 'apppool' $SiteName)) {
    Step "Création du pool d'applications $SiteName"
    AppCmd add apppool /name:"$SiteName"
}
Step "Réglages du pool (toujours démarré, pas de recyclage avec chevauchement)"
AppCmd set apppool /apppool.name:"$SiteName" /managedRuntimeVersion:"" /startMode:AlwaysRunning `
    /processModel.idleTimeout:00:00:00 /processModel.loadUserProfile:true `
    /recycling.periodicRestart.time:00:00:00 /recycling.disallowOverlappingRotation:true `
    /shutdownTimeLimit:00:01:30

$binding = "http/*:${Port}:$HostName"
if (-not $siteExists) {
    Step "Création du site $SiteName ($binding)"
    AppCmd add site /name:"$SiteName" /physicalPath:"$InstallDir" /bindings:"$binding"
}
AppCmd set site /site.name:"$SiteName" /applicationDefaults.applicationPool:"$SiteName" /applicationDefaults.preloadEnabled:true

Step "Droits du pool sur $InstallDir (lecture) et $DataDir (modification)"
$identity = "IIS AppPool\$SiteName"
& icacls $InstallDir /grant "${identity}:(OI)(CI)RX" /T /Q | Out-Null
& icacls (Join-Path $InstallDir 'logs') /grant "${identity}:(OI)(CI)M" /T /Q | Out-Null
& icacls $DataDir /grant "${identity}:(OI)(CI)M" /T /Q | Out-Null
# vigil.json contient les secrets : lecture pour le pool et les administrateurs uniquement.
$config = Join-Path $InstallDir 'vigil.json'
& icacls $config /inheritance:r /grant:r "${identity}:R" "*S-1-5-32-544:F" "*S-1-5-18:F" /Q | Out-Null

Step "Démarrage"
AppCmd start apppool /apppool.name:"$SiteName"
AppCmd start site /site.name:"$SiteName"

$url = "http://localhost:$Port/health"
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    try { $ok = (Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5).StatusCode -eq 200 } catch { Start-Sleep -Seconds 1 }
}

$publicHost = if ($HostName) { $HostName } else { $env:COMPUTERNAME.ToLower() }
Write-Host ""
if ($ok) { Write-Host "Vigil est installé sous IIS." -ForegroundColor Green }
else { Write-Host "Le site ne répond pas encore sur $url : voir $InstallDir\logs et l'Observateur d'événements." -ForegroundColor Yellow }
Write-Host @"

  Interface   : http://${publicHost}:$Port   (admin / $password)
  OTLP HTTP   : http://${publicHost}:$Port/v1/logs, /v1/traces, /v1/metrics
  Clé API     : $apiKey
  Données     : $DataDir
  Config      : $config

  Dans vos applications (appsettings.json) :
    "Vigil": { "Endpoint": "http://${publicHost}:$Port", "ApiKey": "$apiKey" }

"@
