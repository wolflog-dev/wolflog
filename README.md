# Vigil

Logs, traces, métriques et crashs de vos applications .NET dans un seul serveur, installé en une commande.
Vigil remplace la combinaison OpenTelemetry Collector + Loki + Tempo + Prometheus + Grafana.

- **Un binaire** : réception OTLP, stockage, requêtes et interface web embarqués. Aucune base de données à installer.
- **Compatible OpenTelemetry** : OTLP/HTTP (protobuf ou JSON) et OTLP/gRPC. N'importe quel langage peut envoyer ses données.
- **Lib .NET** : `builder.AddVigil();`. Reprend les logs `ILogger` et Serilog, trace ASP.NET Core et HttpClient, collecte les métriques runtime.
- **Crashs** : exceptions non gérées capturées sur disque avant l'arrêt du processus, arrêts brutaux (StackOverflow, kill, recyclage IIS) détectés au redémarrage suivant, avec les derniers logs émis.
- **Rapide** : écriture en colonnes (Parquet + zstd), requêtes vectorisées (DuckDB embarqué), segments ignorés sans lecture grâce à des index (plage de temps, services, trigrammes du texte, filtre de Bloom des trace_id).

---

## 1. Installer le serveur

Téléchargez l'archive correspondant au serveur (voir [Construire les livrables](#5-construire-les-livrables)).

### Linux (systemd)

```bash
tar xzf vigil-linux-x64.tar.gz && cd vigil-linux-x64
sudo bash install.sh              # options : --port 5080 --data /var/lib/vigil
```

Le script copie le binaire dans `/opt/vigil`, crée l'utilisateur système `vigil` et le service `vigil.service`, puis affiche l'adresse, le mot de passe administrateur et la clé API.
Relancer le script avec une nouvelle version met à jour l'installation en conservant la configuration et les données.

### Windows : IIS

Prérequis : IIS et le module ASP.NET Core (Hosting Bundle .NET 10). Le script peut installer les deux.

```powershell
Expand-Archive vigil-win-x64.zip C:\temp\vigil ; cd C:\temp\vigil
.\install-iis.ps1                                   # site "Vigil" sur le port 5080
.\install-iis.ps1 -Port 8080 -HostName vigil.mondomaine.fr
.\install-iis.ps1 -EnableIis -InstallHostingBundle  # serveur vierge
```

Le pool d'applications est configuré pour Vigil : toujours démarré, pas d'arrêt pour inactivité, pas de recyclage périodique ni de recyclage avec chevauchement. Les données sont dans `C:\ProgramData\Vigil`.
Sous IIS, l'OTLP passe par HTTP sur le port du site. Le gRPC (port 4317) n'est disponible qu'en service.

### Windows : service

Copiez le dossier à son emplacement définitif (par exemple `C:\Program Files\Vigil`), puis dans une console administrateur :

```powershell
.\vigil.exe install --port 5080 --open-firewall
```

### Docker

```bash
docker build -t vigil .
docker run -d --name vigil -p 5080:5080 -p 4317:4317 -p 4318:4318 -v vigil-data:/data vigil
docker logs vigil        # identifiants générés au premier démarrage
```

Ou `docker compose -f deploy/docker/docker-compose.yml up -d`.

### Commandes utiles

| Commande | Effet |
|---|---|
| `vigil credentials` | Affiche l'utilisateur, le mot de passe et la clé API |
| `vigil install` / `vigil uninstall` | Installe ou retire le service (les données restent) |
| `vigil init --data <dir>` | Génère `vigil.json` sans installer de service |
| `vigil healthcheck` | Code de sortie 0 si le serveur local répond |

---

## 2. Connecter une application .NET

```bash
dotnet add package Vigil.Client
dotnet add package Vigil.Client.Serilog   # seulement si vous utilisez Serilog
```

`appsettings.json` :

```json
"Vigil": {
  "Endpoint": "http://vigil.mondomaine.fr:5080",
  "ApiKey": "la clé affichée à l'installation"
}
```

`Program.cs` :

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.AddVigil();
```

Cela suffit pour recevoir :

- les logs `ILogger` avec leurs propriétés structurées, les scopes et le `trace_id` ;
- les traces des requêtes entrantes (ASP.NET Core) et sortantes (HttpClient), de Npgsql, MySqlConnector, Azure SDK, MassTransit, et de vos propres `ActivitySource` dont le nom commence comme votre application ;
- les métriques ASP.NET Core, HttpClient et runtime .NET (GC, threads, exceptions), et vos propres `Meter` ;
- les crashs.

### Serilog

Ajoutez `.WriteTo.Vigil()` à votre configuration existante :

```csharp
builder.AddVigil();
builder.Services.AddSerilog((services, log) => log
    .ReadFrom.Configuration(builder.Configuration)
    .WriteTo.Console()
    .WriteTo.Vigil(services));
```

Si vous créez `Log.Logger` avant l'hôte (logger de démarrage), `.WriteTo.Vigil()` sans argument fonctionne aussi. Les événements émis avant le démarrage sont conservés puis envoyés.

### Options

Toutes les options se règlent dans la section `Vigil` ou dans `AddVigil(o => …)` :

| Option | Défaut | Rôle |
|---|---|---|
| `Enabled` | `true` | Désactive tout l'envoi, par exemple en développement |
| `ServiceName` / `ServiceVersion` / `Environment` | nom et version de l'application, `IHostEnvironment` | Identité du service |
| `Logs` / `Traces` / `Metrics` / `Crashes` | `true` | Active chaque type de donnée |
| `TraceSampleRatio` | `1.0` | Échantillonnage des traces |
| `MinimumLevel` | règles `Logging:LogLevel` | Niveau minimum envoyé |
| `ActivitySources` / `Meters` | | Sources supplémentaires, jokers acceptés (`MaSociete.*`) |
| `IgnoredPaths` | `/health`, `/healthz`… | Requêtes non tracées |
| `BufferDirectory` / `MaxBufferSizeMb` | `%TEMP%/vigil/<service>`, 200 | Tampon disque utilisé quand le serveur est injoignable |
| `ConfigureTracing` / `ConfigureMetrics` | | Accès direct au SDK OpenTelemetry, par exemple `t => t.AddEntityFrameworkCoreInstrumentation()` |

### Fonctionnement côté application

- Les envois sont groupés toutes les 2 s, compressés en gzip et authentifiés par la clé API.
- **Serveur injoignable** : les lots sont écrits dans le tampon disque et renvoyés dans l'ordre dès que le serveur répond. Les files d'attente en mémoire sont bornées : l'application n'est jamais ralentie ni bloquée.
- **Crash** : en cas d'exception non gérée, le rapport est écrit sur disque de façon synchrone avec les 40 derniers logs, puis envoyé immédiatement si possible, sinon au démarrage suivant.
- **Arrêt brutal** : StackOverflow, OutOfMemory, `kill -9` ou recyclage IIS forcé ne laissent aucune chance au code .NET. Vigil le détecte au démarrage suivant grâce au marqueur de session et le signale comme crash `Vigil.AbnormalTermination`, avec les derniers logs connus.

### Autres langages

Tout SDK OpenTelemetry fonctionne. Configurez l'exporteur OTLP vers `http://serveur:5080` (ou `:4318`, ou `:4317` en gRPC) avec l'en-tête `x-vigil-key: <clé>`.

---

## 3. Utiliser l'interface

| Page | Contenu |
|---|---|
| Vue d'ensemble | Volumes, taux d'erreur, crashs, latence p95, services, dernières erreurs |
| Logs | Recherche, histogramme (glisser pour zoomer), suivi en direct, détail avec exception, attributs, lien vers la trace |
| Traces | Liste filtrable (opération, durée, erreurs), vue en cascade, logs de chaque span |
| Erreurs | Exceptions regroupées par empreinte (type + frames applicatives), crashs, fréquence, pile d'appels, logs précédant le crash |
| Métriques | Toutes les métriques reçues, regroupées par service ou par attribut, percentiles des histogrammes |
| Système | Stockage, et code d'intégration prêt à copier avec la clé API |

Syntaxe de recherche des logs :

```
timeout                          texte dans le message ou l'exception
"connexion refusée"              phrase exacte
-healthcheck                     exclut un mot
service:api level:warn           service, niveau minimum (trace, debug, info, warn, error, fatal)
host:web-* env:prod version:1.4  colonnes, joker *
http.route:/users/*              n'importe quel attribut
trace:<id>  fingerprint:<id>  crash:true  has:exception
```

---

## 4. Configuration du serveur

Fichiers lus dans cet ordre (le dernier l'emporte) : `appsettings.json`, puis `vigil.json` à côté du binaire, puis `/etc/vigil/vigil.json` (Linux), puis les variables d'environnement (`Vigil__Retention__LogsDays=30`).

```json
{
  "Vigil": {
    "DataDirectory": "/var/lib/vigil",
    "Auth": { "AdminUser": "admin", "AdminPassword": "…", "ApiKeys": [ "…", "…" ] },
    "Storage": { "FlushIntervalSeconds": 60, "FlushRows": 100000, "FsyncWal": false, "MemoryLimit": "2GB" },
    "Retention": { "LogsDays": 14, "TracesDays": 7, "MetricsDays": 30, "MaxDiskGb": 50 }
  },
  "Kestrel": { "Endpoints": { "Web": { "Url": "https://0.0.0.0:443", "Certificate": { "Path": "cert.pfx", "Password": "…" } } } }
}
```

Plusieurs clés API peuvent coexister, par exemple une par application ou par environnement, et une clé se révoque en la retirant de la liste.
Sans mot de passe ni clé configurés, le serveur en génère au premier démarrage (`<data>/secrets.json`).

### HTTPS

Utilisez un reverse proxy (IIS, Nginx, Caddy) ou configurez directement un certificat Kestrel comme dans l'exemple ci-dessus.
Derrière Nginx, désactivez le buffering pour `/api/logs/tail` : `proxy_buffering off;`.

---

## 5. Construire les livrables

Prérequis : SDK .NET 10 et Node.js 22.22 ou plus récent (24 LTS recommandé) pour l'interface Angular.

```powershell
./build/package.ps1             # UI, tests, publications et paquets NuGet dans dist/
./build/package.ps1 -Version 0.2.0 -SkipTests
```

Développement :

```bash
dotnet run --project src/Vigil.Server          # API sur http://localhost:5080
cd ui && npm start                             # interface sur http://localhost:4200 (proxy vers l'API)
dotnet run --project samples/Vigil.Demo        # application de démo qui envoie des données
dotnet test --project tests/Vigil.Tests
```

`Vigil__Auth__Enabled=false` désactive l'authentification en local.

---

## 6. Architecture

```
Applications ──OTLP (HTTP/gRPC, gzip, clé API)──► Vigil
                                                  │
     ┌────────────────────────────────────────────┤
     │ 1. WAL : lot écrit sur disque avant l'accusé de réception
     │ 2. Table DuckDB en mémoire : interrogeable immédiatement
     │ 3. Toutes les 60 s ou 100 000 lignes : segment Parquet (zstd, trié par temps)
     │    avec index : min/max temps, services, sévérité max, trigrammes du texte, Bloom des trace_id
     │ 4. Compaction horaire : les segments d'une heure fusionnés en un seul fichier
     │ 5. Rétention par type de donnée et limite de disque
     └──► Requêtes : snapshot immuable → segments élagués par les index → DuckDB (SQL vectorisé)
```

| Projet | Rôle |
|---|---|
| `src/Vigil.Server` | Serveur : ingestion OTLP, stockage, API, interface embarquée, installeur |
| `src/Vigil.Client` | Lib .NET (NuGet) : configuration OpenTelemetry, transport avec tampon disque, crashs |
| `src/Vigil.Client.Serilog` | Sink Serilog |
| `src/Vigil.Protocol` | Messages OTLP générés depuis les `.proto` officiels |
| `ui/` | Interface Angular 22 (signals, zoneless), uPlot, CDK virtual scroll |
| `samples/Vigil.Demo` | Application de démonstration (Serilog, trafic, erreurs, crash) |
| `tests/Vigil.Tests` | Tests unitaires, stockage (WAL, compaction, rétention) et bout en bout |
