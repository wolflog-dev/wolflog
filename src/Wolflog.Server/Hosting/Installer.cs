using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Wolflog.Server.Hosting;

/// <summary>
/// Installation en une commande :
///   Linux   : sudo ./wolflog install     → service systemd, utilisateur dédié, /var/lib/wolflog
///   Windows : wolflog.exe install        → service Windows (console administrateur)
///   IIS     : voir deploy/iis/install-iis.ps1
/// </summary>
public static class Installer
{
    private const string Help = """
        Wolflog - observabilité tout-en-un (logs, traces, métriques, crashs)

        Usage :
          wolflog                       Démarre le serveur
          wolflog install [options]     Installe et démarre le service (systemd ou service Windows)
          wolflog uninstall             Arrête et supprime le service (les données sont conservées)
          wolflog init [options]        Crée wolflog.json (identifiants générés) sans installer de service (IIS, Docker…)
          wolflog credentials           Affiche le mot de passe initial et la clé API
          wolflog reset-password [user] Nouveau mot de passe provisoire (défaut : admin)
          wolflog backup <fichier.zip> [--config-only]
                                      Sauvegarde configuration et données (serveur démarré ou non)
          wolflog restore <fichier.zip> Restaure une sauvegarde (serveur arrêté)
          wolflog agent [options]       Lit des fichiers de logs (IIS, texte, JSON, Docker…) et les envoie à un Wolflog distant
          wolflog healthcheck [--url u] Vérifie que le serveur local répond (code de sortie 0/1)
          wolflog version               Affiche la version

        Options d'installation :
          --port <n>          Port de l'interface et de l'OTLP/HTTP (défaut 5080)
          --data <dossier>    Dossier des données (défaut /var/lib/wolflog ou C:\ProgramData\Wolflog)
          --name <nom>        Nom du service (défaut wolflog / Wolflog)
          --open-firewall     Ouvre les ports dans le pare-feu (Windows)
          --no-start          N'active pas le démarrage immédiat
        """;

    public static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        var command = args[0].ToLowerInvariant();
        try
        {
            switch (command)
            {
                case "install": exitCode = Install(Parse(args)); return true;
                case "uninstall": exitCode = Uninstall(Parse(args)); return true;
                case "credentials": exitCode = ShowCredentials(); return true;
                case "reset-password": exitCode = ResetPassword(args.Length > 1 && !args[1].StartsWith("--") ? args[1] : "admin"); return true;
                case "init": exitCode = Init(Parse(args)); return true;
                case "backup": exitCode = BackupCommand(args); return true;
                case "restore": exitCode = RestoreCommand(args); return true;
                case "agent": exitCode = Sources.Agent.Run(args); return true;
                case "healthcheck": exitCode = HealthCheck(Parse(args)); return true;
                case "version" or "--version" or "-v":
                    Console.WriteLine(typeof(Installer).Assembly.GetName().Version?.ToString(3));
                    return true;
                case "help" or "--help" or "-h" or "/?":
                    Console.WriteLine(Help);
                    return true;
                default:
                    return false; // arguments destinés à ASP.NET (ex: --urls)
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Erreur : {ex.Message}");
            exitCode = 1;
            return true;
        }
    }

    private static Dictionary<string, string> Parse(string[] args)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--")) continue;
            var key = args[i][2..];
            d[key] = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[++i] : "true";
        }
        return d;
    }

    private static string ExePath => Environment.ProcessPath ?? throw new InvalidOperationException("Chemin du binaire introuvable.");

    // ------------------------------------------------------------------ install

    private static int Install(Dictionary<string, string> o)
    {
        var port = o.TryGetValue("port", out var p) ? int.Parse(p) : 5080;
        var start = !o.ContainsKey("no-start");

        if (OperatingSystem.IsLinux()) return InstallLinux(o, port, start);
        if (OperatingSystem.IsWindows()) return InstallWindows(o, port, start);
        Console.Error.WriteLine("Installation automatique disponible sous Linux (systemd) et Windows. Utilisez Docker sinon.");
        return 1;
    }

    private static int InstallLinux(Dictionary<string, string> o, int port, bool start)
    {
        if (!IsRoot()) throw new InvalidOperationException("lancez la commande avec sudo.");
        var name = o.GetValueOrDefault("name", "wolflog");
        var data = o.GetValueOrDefault("data", "/var/lib/wolflog");
        var exe = ExePath;
        var dir = Path.GetDirectoryName(exe)!;

        if (Run("id", "-u wolflog", quiet: true) != 0)
            Run("useradd", "--system --no-create-home --shell /usr/sbin/nologin wolflog");
        Directory.CreateDirectory(data);
        Run("chown", $"-R wolflog:wolflog \"{data}\"");

        Directory.CreateDirectory("/etc/wolflog");
        var configPath = "/etc/wolflog/wolflog.json";
        var (password, apiKey) = WriteConfig(configPath, data, port);
        Run("chown", $"root:wolflog {configPath}");
        Run("chmod", $"640 {configPath}");

        var unit = $"""
            [Unit]
            Description=Wolflog - observabilité (logs, traces, métriques, crashs)
            After=network-online.target
            Wants=network-online.target

            [Service]
            Type=notify
            User=wolflog
            Group=wolflog
            WorkingDirectory={dir}
            ExecStart={exe}
            Restart=always
            RestartSec=5
            TimeoutStopSec=90
            LimitNOFILE=65536
            Environment=ASPNETCORE_ENVIRONMENT=Production
            Environment=DOTNET_BUNDLE_EXTRACT_BASE_DIR={data}/.bundle

            [Install]
            WantedBy=multi-user.target
            """;
        File.WriteAllText($"/etc/systemd/system/{name}.service", unit + "\n");
        Run("systemctl", "daemon-reload");
        Run("systemctl", start ? $"enable --now {name}" : $"enable {name}");

        PrintSummary(port, password, apiKey, data, $"systemctl status {name}   |   journalctl -u {name} -f");
        return 0;
    }

    private static int InstallWindows(Dictionary<string, string> o, int port, bool start)
    {
        if (!IsWindowsAdmin()) throw new InvalidOperationException("lancez la commande dans une console « Exécuter en tant qu'administrateur ».");
        var name = o.GetValueOrDefault("name", "Wolflog");
        var data = o.GetValueOrDefault("data", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Wolflog"));
        var exe = ExePath;
        Directory.CreateDirectory(data);

        var configPath = Path.Combine(Path.GetDirectoryName(exe)!, "wolflog.json");
        var (password, apiKey) = WriteConfig(configPath, data, port);

        Run("sc.exe", $"create {name} binPath= \"\\\"{exe}\\\"\" start= delayed-auto DisplayName= \"Wolflog\"");
        Run("sc.exe", $"description {name} \"Wolflog - observabilité (logs, traces, métriques, crashs)\"");
        Run("sc.exe", $"failure {name} reset= 86400 actions= restart/5000/restart/10000/restart/30000");
        if (o.ContainsKey("open-firewall"))
        {
            Run("netsh", $"advfirewall firewall add rule name=\"Wolflog\" dir=in action=allow protocol=TCP localport={port},4317,4318");
        }
        if (start) Run("sc.exe", $"start {name}");

        PrintSummary(port, password, apiKey, data, $"sc.exe query {name}   |   Observateur d'événements > Journaux Windows > Application");
        return 0;
    }

    /// <summary>Crée (ou complète) le fichier de configuration local avec des identifiants générés.</summary>
    private static (string Password, string ApiKey) WriteConfig(string path, string data, int port)
    {
        var root = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : new JsonObject();
        var wolflog = root["Wolflog"] as JsonObject ?? new JsonObject();
        root["Wolflog"] = wolflog;
        wolflog["DataDirectory"] = data;
        var authNode = wolflog["Auth"] as JsonObject ?? new JsonObject();
        wolflog["Auth"] = authNode;

        var password = authNode["AdminPassword"]?.GetValue<string>();
        if (string.IsNullOrEmpty(password)) authNode["AdminPassword"] = password = AuthService.NewSecret(18);
        var keys = authNode["ApiKeys"] as JsonArray;
        string apiKey;
        if (keys is { Count: > 0 }) apiKey = keys[0]!.GetValue<string>();
        else authNode["ApiKeys"] = new JsonArray(apiKey = AuthService.NewSecret(32));

        // Ne modifie que l'URL de l'interface : le reste de la section Kestrel (certificat HTTPS…) est conservé.
        var kestrel = root["Kestrel"] as JsonObject ?? new JsonObject();
        root["Kestrel"] = kestrel;
        var endpoints = kestrel["Endpoints"] as JsonObject ?? new JsonObject();
        kestrel["Endpoints"] = endpoints;
        var web = endpoints["Web"] as JsonObject ?? new JsonObject();
        endpoints["Web"] = web;
        if (web["Url"] is null || !web["Url"]!.GetValue<string>().StartsWith("https", StringComparison.OrdinalIgnoreCase))
            web["Url"] = $"http://0.0.0.0:{port}";
        File.WriteAllText(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return (password!, apiKey);
    }

    private static void PrintSummary(int port, string password, string apiKey, string data, string hint)
    {
        var host = Environment.MachineName.ToLowerInvariant();
        Console.WriteLine($"""

            ✔ Wolflog est installé.

              Interface      : http://{host}:{port}   (utilisateur : admin / mot de passe : {password})
              OTLP HTTP      : http://{host}:{port}  ou  http://{host}:4318
              OTLP gRPC      : http://{host}:4317
              Clé API        : {apiKey}
              Données        : {data}
              Diagnostic     : {hint}

            Dans vos applications .NET (appsettings.json) :
              "Wolflog": {"{"} "Endpoint": "http://{host}:{port}", "ApiKey": "{apiKey}" {"}"}

            """);
    }

    /// <summary>Écrit wolflog.json à côté du binaire (utilisé par le script IIS).</summary>
    private static int Init(Dictionary<string, string> o)
    {
        var port = o.TryGetValue("port", out var p) ? int.Parse(p) : 5080;
        var data = o.GetValueOrDefault("data", Path.Combine(AppContext.BaseDirectory, "data"));
        Directory.CreateDirectory(data);
        var (password, apiKey) = WriteConfig(Path.Combine(AppContext.BaseDirectory, "wolflog.json"), data, port);
        if (o.ContainsKey("quiet"))
        {
            // Sortie exploitable par un script : mot de passe puis clé API.
            Console.WriteLine(password);
            Console.WriteLine(apiKey);
        }
        else
        {
            PrintSummary(port, password, apiKey, data, "wolflog credentials");
        }
        return 0;
    }

    private static int HealthCheck(Dictionary<string, string> o)
    {
        var url = o.GetValueOrDefault("url", "http://127.0.0.1:5080/health");
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
            return http.GetAsync(url).GetAwaiter().GetResult().IsSuccessStatusCode ? 0 : 1;
        }
        catch (Exception)
        {
            return 1;
        }
    }

    // ------------------------------------------------------------------ uninstall

    private static int Uninstall(Dictionary<string, string> o)
    {
        if (OperatingSystem.IsLinux())
        {
            if (!IsRoot()) throw new InvalidOperationException("lancez la commande avec sudo.");
            var name = o.GetValueOrDefault("name", "wolflog");
            Run("systemctl", $"disable --now {name}");
            File.Delete($"/etc/systemd/system/{name}.service");
            Run("systemctl", "daemon-reload");
        }
        else if (OperatingSystem.IsWindows())
        {
            if (!IsWindowsAdmin()) throw new InvalidOperationException("console administrateur requise.");
            var name = o.GetValueOrDefault("name", "Wolflog");
            Run("sc.exe", $"stop {name}", quiet: true);
            Run("sc.exe", $"delete {name}");
        }
        Console.WriteLine("Service supprimé. Les données et la configuration ont été conservées.");
        return 0;
    }

    // ------------------------------------------------------------------ credentials

    private static int ResetPassword(string username)
    {
        var options = LoadOptions();
        var users = new UserStore(options.ResolveDataDirectory(AppContext.BaseDirectory));
        var user = users.ByUsername(username);
        if (user is null)
        {
            Console.Error.WriteLine($"Utilisateur « {username} » introuvable. Comptes : {string.Join(", ", users.All().Select(u => u.Username))}");
            return 1;
        }
        var password = Passwords.Generate(12);
        users.Update(user.Id, u =>
        {
            u.PasswordHash = Passwords.Hash(password);
            u.MustChangePassword = true;
            u.Source = "local";
            u.Disabled = false;
        });
        Console.WriteLine($"Nouveau mot de passe provisoire de « {user.Username} » : {password}");
        Console.WriteLine("Il devra être changé à la prochaine connexion.");
        return 0;
    }

    private static int BackupCommand(string[] args)
    {
        var file = args.Skip(1).FirstOrDefault(a => !a.StartsWith("--")) ?? $"wolflog-{DateTime.Now:yyyyMMdd-HHmm}.zip";
        var configOnly = args.Contains("--config-only");
        var data = LoadOptions().ResolveDataDirectory(AppContext.BaseDirectory);
        if (!Directory.Exists(data))
        {
            Console.Error.WriteLine($"Dossier de données introuvable : {data}");
            return 1;
        }
        using (var output = File.Create(file)) Backup.Write(data, output, includeData: !configOnly);
        Monitoring.BackupState.Mark(data);
        var size = new FileInfo(file).Length;
        Console.WriteLine($"Sauvegarde écrite : {Path.GetFullPath(file)} ({(size < 1024 * 1024 ? $"{Math.Max(1, size / 1024)} Ko" : $"{size / 1024d / 1024:0.#} Mo")})");
        if (!configOnly) Console.WriteLine("Les données reçues depuis moins d'une minute (encore en mémoire) n'y figurent que si elles ont été écrites sur disque.");
        return 0;
    }

    private static int RestoreCommand(string[] args)
    {
        var file = args.Skip(1).FirstOrDefault(a => !a.StartsWith("--"));
        if (file is null || !File.Exists(file))
        {
            Console.Error.WriteLine("Usage : wolflog restore <fichier.zip>");
            return 1;
        }
        var data = LoadOptions().ResolveDataDirectory(AppContext.BaseDirectory);
        Directory.CreateDirectory(data);
        // Le serveur ne doit pas tourner : il réécrirait par-dessus.
        try
        {
            using var _ = new FileStream(Path.Combine(data, ".lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
        }
        catch (IOException)
        {
            Console.Error.WriteLine("Wolflog est en cours d'exécution sur ce dossier de données : arrêtez le service avant de restaurer.");
            return 1;
        }
        using var input = File.OpenRead(file);
        var result = Backup.Restore(data, input, includeData: true);
        Console.WriteLine($"Restauré dans {data} : {result.ConfigFiles} fichier(s) de configuration, {result.DataFiles} fichier(s) de données.");
        return 0;
    }

    private static WolflogServerOptions LoadOptions()
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile("wolflog.json", optional: true)
            .AddJsonFile("/etc/wolflog/wolflog.json", optional: true)
            .AddEnvironmentVariables()
            .AddEnvironmentVariables("WOLFLOG_")
            .Build();
        var options = new WolflogServerOptions();
        config.GetSection(WolflogServerOptions.Section).Bind(options);
        return options;
    }

    private static int ShowCredentials()
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile("wolflog.json", optional: true)
            .AddJsonFile("/etc/wolflog/wolflog.json", optional: true)
            .AddEnvironmentVariables("WOLFLOG_")
            .Build();
        var options = new WolflogServerOptions();
        config.GetSection(WolflogServerOptions.Section).Bind(options);

        var password = options.Auth.AdminPassword;
        var apiKey = options.Auth.ApiKeys.FirstOrDefault();
        var secretsPath = Path.Combine(options.ResolveDataDirectory(AppContext.BaseDirectory), "secrets.json");
        if ((string.IsNullOrEmpty(password) || apiKey is null) && File.Exists(secretsPath))
        {
            var secrets = JsonSerializer.Deserialize<AuthService.Secrets>(File.ReadAllText(secretsPath));
            if (string.IsNullOrEmpty(password)) password = secrets?.AdminPassword;
            apiKey ??= secrets?.ApiKeys.FirstOrDefault();
        }

        Console.WriteLine($"Utilisateur : {options.Auth.AdminUser}");
        Console.WriteLine($"Mot de passe: {(string.IsNullOrEmpty(password) ? "(généré au premier démarrage)" : password)}");
        Console.WriteLine($"Clé API     : {apiKey ?? "(générée au premier démarrage)"}");
        return 0;
    }

    // ------------------------------------------------------------------ utilitaires

    private static int Run(string file, string arguments, bool quiet = false)
    {
        var psi = new ProcessStartInfo(file, arguments)
        {
            RedirectStandardOutput = quiet,
            RedirectStandardError = quiet,
            UseShellExecute = false,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Impossible de lancer {file}");
        p.WaitForExit();
        if (p.ExitCode != 0 && !quiet) Console.Error.WriteLine($"  ({file} {arguments} → code {p.ExitCode})");
        return p.ExitCode;
    }

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint GetEuid();

    private static bool IsRoot() => GetEuid() == 0;

    private static bool IsWindowsAdmin()
    {
        if (!OperatingSystem.IsWindows()) return false;
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        return new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    }
}
