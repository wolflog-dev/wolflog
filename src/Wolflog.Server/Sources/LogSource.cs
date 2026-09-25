namespace Wolflog.Server.Sources;

/// <summary>Source de logs lue par Wolflog lui-même (sans bibliothèque dans l'application).</summary>
public sealed class LogSource : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>file ou syslog.</summary>
    public string Type { get; set; } = "file";

    // Fichiers
    /// <summary>Chemin, avec * possible dans le nom (ex. C:\inetpub\logs\LogFiles\W3SVC1\*.log, /var/log/app/*.log).</summary>
    public string? Path { get; set; }
    /// <summary>auto, plain, json, iis, docker, cri.</summary>
    public string Format { get; set; } = "auto";
    /// <summary>Au premier démarrage : ne lire que les nouvelles lignes (true) ou tout le fichier (false).</summary>
    public bool StartAtEnd { get; set; } = true;

    // Syslog
    public int Port { get; set; } = 5514;
    /// <summary>udp, tcp ou both.</summary>
    public string Protocol { get; set; } = "both";

    /// <summary>Nom de service attribué aux entrées (sinon celui lu dans la ligne, sinon le nom de la source).</summary>
    public string? Service { get; set; }
    public string? Env { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
