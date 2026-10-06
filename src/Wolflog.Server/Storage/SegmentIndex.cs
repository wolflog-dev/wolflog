using System.Text.Json.Serialization;

namespace Wolflog.Server.Storage;

/// <summary>Métadonnées d'un segment, utilisées pour éviter d'ouvrir les fichiers inutiles.</summary>
public sealed class SegmentIndex
{
    public DateTime MinTs { get; set; } = DateTime.MaxValue;
    public DateTime MaxTs { get; set; } = DateTime.MinValue;
    public long Rows { get; set; }
    public HashSet<string> Services { get; set; } = new(StringComparer.Ordinal);
    public byte MaxSeverity { get; set; }
    public bool HasExceptions { get; set; }
    /// <summary>Version des colonnes du segment (<see cref="SignalSchema{TRow}.Version"/>) ; 0 si inconnue (index ancien ou reconstruit).</summary>
    public int Version { get; set; }

    /// <summary>
    /// Identifiants de trace du segment (logs et traces) ; null tant qu'aucun n'a été ajouté. Le filtre pèse 32 Ko et
    /// reste en mémoire tant que le segment est conservé : les métriques et l'audience, qui n'en ont pas, n'en allouent plus.
    /// </summary>
    [JsonIgnore] public BloomFilter? TraceIds { get; set; }
    [JsonIgnore] public TrigramSet? Text { get; set; }

    // Un filtre vide (index écrits quand chaque segment en avait un) n'est pas chargé : il n'élague rien de plus que null.
    public string? TraceIdsData
    {
        get => TraceIds?.ToBase64();
        set { if (value != null && BloomFilter.FromBase64(value) is { IsEmpty: false } filter) TraceIds = filter; }
    }
    public string? TextData { get => Text?.ToBase64(); set { if (value != null) Text = TrigramSet.FromBase64(value); } }

    public void AddTraceId(string? traceId)
    {
        if (string.IsNullOrEmpty(traceId)) return;
        (TraceIds ??= new BloomFilter()).Add(traceId);
    }

    /// <summary>false si le segment ne contient certainement pas cette trace (aucun identifiant, ou absente du filtre).</summary>
    public bool MayContainTraceId(string traceId) => TraceIds?.MayContain(traceId) ?? false;

    public void AddTimestamp(DateTime ts)
    {
        if (ts < MinTs) MinTs = ts;
        if (ts > MaxTs) MaxTs = ts;
        Rows++;
    }

    public void AddService(string service)
    {
        // Les HashSet évitent les doublons ; la taille reste petite (nombre de services).
        Services.Add(service);
    }

    public void Merge(SegmentIndex other)
    {
        if (other.MinTs < MinTs) MinTs = other.MinTs;
        if (other.MaxTs > MaxTs) MaxTs = other.MaxTs;
        Rows += other.Rows;
        Services.UnionWith(other.Services);
        if (other.MaxSeverity > MaxSeverity) MaxSeverity = other.MaxSeverity;
        HasExceptions |= other.HasExceptions;
        if (other.TraceIds != null)
        {
            TraceIds ??= new BloomFilter();
            TraceIds.UnionWith(other.TraceIds);
        }
        if (other.Text != null)
        {
            Text ??= new TrigramSet();
            Text.UnionWith(other.Text);
        }
    }

    /// <summary>Index "inconnu" : ne permet aucun élagage (utilisé si le fichier d'index est perdu).</summary>
    public static SegmentIndex Unknown(DateTime min, DateTime max, long rows, IEnumerable<string> services) => new()
    {
        MinTs = min,
        MaxTs = max,
        Rows = rows,
        Services = new HashSet<string>(services, StringComparer.Ordinal),
        MaxSeverity = byte.MaxValue,
        HasExceptions = true,
        TraceIds = BloomFilter.Full(),
        Text = TrigramSet.Full(),
    };
}
