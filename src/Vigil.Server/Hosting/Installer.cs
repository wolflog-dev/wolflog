using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vigil.Server.Security;

namespace Vigil.Server.Hosting;

/// <summary>
/// Installation en une commande :
///   Linux   : sudo ./vigil install     → service systemd, utilisateur dédié, /var/lib/vigil
///   Windows : vigil.exe install        → service Windows (console administrateur)
///   IIS     : voir deploy/iis/install-iis.ps1
/// </summary>
public static class Installer
{
    private const string Help = """
        Vigil - observabilité tout-en-un (logs, traces, métriques, crashs)

        Usage :
          vigil                       Démarre le serveur
          vigil install [options]     Installe et démarre le service (systemd ou service Windows)
          vigil uninstall             Arrête et supprime le service (les données sont conservées)
          vigil credentials           Affiche l'utilisateur, le mot de passe et la clé API
          vigil version               Affiche la version

        Options d'installation :
          --port <n>          Port de l'interface et de l'OTLP/HTTP (défaut 5080)
          --data <dossier>    Dossier des données (défaut /var/lib/vigil ou C:\ProgramData\Vigil)
          --name <nom>        Nom du service (défaut vigil / Vigil)
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
        var name = o.GetValueOrDefault("name", "vigil");
        var data = o.GetValueOrDefault("data", "/var/lib/vigil");
        var exe = ExePath;
        var dir = Path.GetDirectoryName(exe)!;

        if (Run("id", "-u vigil", quiet: true) != 0)
            Run("useradd", "--system --no-create-home --shell /usr/sbin/nologin vigil");
        Directory.CreateDirectory(data);
        Run("chown", $"-R vigil:vigil \"{data}\"");

        Directory.CreateDirectory("/etc/vigil");
        var configPath = "/etc/vigil/vigil.json";
        var (password, apiKey) = WriteConfig(configPath, data, port);
        Run("chown", $"root:vigil {configPath}");
        Run("chmod", $"640 {configPath}");

        var unit = $"""
            [Unit]
            Description=Vigil - observabilité (logs, traces, métriques, crashs)
            After=network-online.target
            Wants=network-online.target

            [Service]
            Type=notify
            User=vigil
            Group=vigil
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
        var name = o.GetValueOrDefault("name", "Vigil");
        var data = o.GetValueOrDefault("data", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Vigil"));
        var exe = ExePath;
        Directory.CreateDirectory(data);

        var configPath = Path.Combine(Path.GetDirectoryName(exe)!, "vigil.json");
        var (password, apiKey) = WriteConfig(configPath, data, port);

        Run("sc.exe", $"create {name} binPath= \"\\\"{exe}\\\"\" start= delayed-auto DisplayName= \"Vigil\"");
        Run("sc.exe", $"description {name} \"Vigil - observabilité (logs, traces, métriques, crashs)\"");
        Run("sc.exe", $"failure {name} reset= 86400 actions= restart/5000/restart/10000/restart/30000");
        if (o.ContainsKey("open-firewall"))
        {
            Run("netsh", $"advfirewall firewall add rule name=\"Vigil\" dir=in action=allow protocol=TCP localport={port},4317,4318");
        }
        if (start) Run("sc.exe", $"start {name}");

        PrintSummary(port, password, apiKey, data, $"sc.exe query {name}   |   Observateur d'événements > Journaux Windows > Application");
        return 0;
    }

    /// <summary>Crée (ou complète) le fichier de configuration local avec des identifiants générés.</summary>
    private static (string Password, string ApiKey) WriteConfig(string path, string data, int port)
    {
        var root = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : new JsonObject();
        var vigil = root["Vigil"] as JsonObject ?? new JsonObject();
        root["Vigil"] = vigil;
        vigil["DataDirectory"] = data;
        var authNode = vigil["Auth"] as JsonObject ?? new JsonObject();
        vigil["Auth"] = authNode;

        var password = authNode["AdminPassword"]?.GetValue<string>();
        if (string.IsNullOrEmpty(password)) authNode["AdminPassword"] = password = AuthService.NewSecret(18);
        var keys = authNode["ApiKeys"] as JsonArray;
        string apiKey;
        if (keys is { Count: > 0 }) apiKey = keys[0]!.GetValue<string>();
        else authNode["ApiKeys"] = new JsonArray(apiKey = AuthService.NewSecret(32));

        root["Kestrel"] = new JsonObject
        {
            ["Endpoints"] = new JsonObject
            {
                ["Web"] = new JsonObject { ["Url"] = $"http://0.0.0.0:{port}" },
            },
        };
        File.WriteAllText(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return (password!, apiKey);
    }

    private static void PrintSummary(int port, string password, string apiKey, string data, string hint)
    {
        var host = Environment.MachineName.ToLowerInvariant();
        Console.WriteLine($"""

            ✔ Vigil est installé.

              Interface      : http://{host}:{port}   (utilisateur : admin / mot de passe : {password})
              OTLP HTTP      : http://{host}:{port}  ou  http://{host}:4318
              OTLP gRPC      : http://{host}:4317
              Clé API        : {apiKey}
              Données        : {data}
              Diagnostic     : {hint}

            Dans vos applications .NET (appsettings.json) :
              "Vigil": {"{"} "Endpoint": "http://{host}:{port}", "ApiKey": "{apiKey}" {"}"}

            """);
    }

    // ------------------------------------------------------------------ uninstall

    private static int Uninstall(Dictionary<string, string> o)
    {
        if (OperatingSystem.IsLinux())
        {
            if (!IsRoot()) throw new InvalidOperationException("lancez la commande avec sudo.");
            var name = o.GetValueOrDefault("name", "vigil");
            Run("systemctl", $"disable --now {name}");
            File.Delete($"/etc/systemd/system/{name}.service");
            Run("systemctl", "daemon-reload");
        }
        else if (OperatingSystem.IsWindows())
        {
            if (!IsWindowsAdmin()) throw new InvalidOperationException("console administrateur requise.");
            var name = o.GetValueOrDefault("name", "Vigil");
            Run("sc.exe", $"stop {name}", quiet: true);
            Run("sc.exe", $"delete {name}");
        }
        Console.WriteLine("Service supprimé. Les données et la configuration ont été conservées.");
        return 0;
    }

    // ------------------------------------------------------------------ credentials

    private static int ShowCredentials()
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile("vigil.json", optional: true)
            .AddJsonFile("/etc/vigil/vigil.json", optional: true)
            .AddEnvironmentVariables("VIGIL_")
            .Build();
        var options = new VigilServerOptions();
        config.GetSection(VigilServerOptions.Section).Bind(options);

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
