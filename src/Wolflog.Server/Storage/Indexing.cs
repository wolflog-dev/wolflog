using System.Numerics;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace Wolflog.Server.Storage;

/// <summary>
/// Ensemble exact des trigrammes [a-z0-9]{3} présents dans un segment (36^3 bits = 5,8 Ko).
/// Permet d'écarter un segment sans l'ouvrir quand un terme recherché n'y figure pas.
/// Aucun faux négatif : si un texte contient la sous-chaîne recherchée, tous ses trigrammes sont présents.
/// </summary>
public sealed class TrigramSet
{
    public const int Size = 36 * 36 * 36;
    private readonly ulong[] _bits;

    public TrigramSet() => _bits = new ulong[(Size + 63) / 64];
    private TrigramSet(ulong[] bits) => _bits = bits;

    public static TrigramSet Full()
    {
        var s = new TrigramSet();
        Array.Fill(s._bits, ulong.MaxValue);
        return s;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int Code(char c)
    {
        if (c is >= 'a' and <= 'z') return c - 'a';
        if (c is >= 'A' and <= 'Z') return c - 'A';
        if (c is >= '0' and <= '9') return 26 + (c - '0');
        return -1;
    }

    public void AddText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return;
        int a = -1, b = -1;
        foreach (var ch in text)
        {
            var c = Code(ch);
            if (c < 0) { a = b = -1; continue; }
            if (a >= 0)
            {
                var t = a * 1296 + b * 36 + c;
                _bits[t >> 6] |= 1UL << (t & 63);
            }
            a = b; b = c;
        }
    }

    /// <summary>true si le segment PEUT contenir le terme (tous ses trigrammes sont présents).</summary>
    public bool MayContain(string term)
    {
        int a = -1, b = -1;
        foreach (var ch in term)
        {
            var c = Code(ch);
            if (c < 0) { a = b = -1; continue; }
            if (a >= 0)
            {
                var t = a * 1296 + b * 36 + c;
                if ((_bits[t >> 6] & (1UL << (t & 63))) == 0) return false;
            }
            a = b; b = c;
        }
        return true;
    }

    public void UnionWith(TrigramSet other)
    {
        for (var i = 0; i < _bits.Length; i++) _bits[i] |= other._bits[i];
    }

    public string ToBase64() => Convert.ToBase64String(System.Runtime.InteropServices.MemoryMarshal.AsBytes(_bits.AsSpan()));

    public static TrigramSet FromBase64(string s)
    {
        var bytes = Convert.FromBase64String(s);
        var bits = new ulong[(Size + 63) / 64];
        bytes.AsSpan().CopyTo(System.Runtime.InteropServices.MemoryMarshal.AsBytes(bits.AsSpan()));
        return new TrigramSet(bits);
    }
}

/// <summary>Filtre de Bloom de taille fixe (fusionnable par OU binaire) pour les identifiants de trace.</summary>
public sealed class BloomFilter
{
    private const int Bits = 1 << 18; // 32 Ko
    private const int Hashes = 4;
    private readonly ulong[] _bits;

    public BloomFilter() => _bits = new ulong[Bits / 64];
    private BloomFilter(ulong[] bits) => _bits = bits;

    public static BloomFilter Full()
    {
        var f = new BloomFilter();
        Array.Fill(f._bits, ulong.MaxValue);
        return f;
    }

    private static ulong Hash(string s)
    {
        // FNV-1a 64 bits : stable entre processus (contrairement à string.GetHashCode).
        var h = 14695981039346656037UL;
        foreach (var c in s)
        {
            h ^= c;
            h *= 1099511628211UL;
        }
        return h;
    }

    public void Add(string? value)
    {
        if (string.IsNullOrEmpty(value)) return;
        var h = Hash(value);
        uint h1 = (uint)h, h2 = (uint)(h >> 32) | 1;
        for (uint i = 0; i < Hashes; i++)
        {
            var bit = (h1 + i * h2) & (Bits - 1);
            _bits[bit >> 6] |= 1UL << (int)(bit & 63);
        }
    }

    public bool MayContain(string value)
    {
        var h = Hash(value);
        uint h1 = (uint)h, h2 = (uint)(h >> 32) | 1;
        for (uint i = 0; i < Hashes; i++)
        {
            var bit = (h1 + i * h2) & (Bits - 1);
            if ((_bits[bit >> 6] & (1UL << (int)(bit & 63))) == 0) return false;
        }
        return true;
    }

    public void UnionWith(BloomFilter other)
    {
        for (var i = 0; i < _bits.Length; i++) _bits[i] |= other._bits[i];
    }

    public double FillRatio()
    {
        long set = 0;
        foreach (var w in _bits) set += BitOperations.PopCount(w);
        return (double)set / Bits;
    }

    public string ToBase64() => Convert.ToBase64String(System.Runtime.InteropServices.MemoryMarshal.AsBytes(_bits.AsSpan()));

    public static BloomFilter FromBase64(string s)
    {
        var bytes = Convert.FromBase64String(s);
        var bits = new ulong[Bits / 64];
        bytes.AsSpan().CopyTo(System.Runtime.InteropServices.MemoryMarshal.AsBytes(bits.AsSpan()));
        return new BloomFilter(bits);
    }
}

/// <summary>Métadonnées d'un segment, utilisées pour éviter d'ouvrir les fichiers inutiles.</summary>
public sealed class SegmentIndex
{
    public DateTime MinTs { get; set; } = DateTime.MaxValue;
    public DateTime MaxTs { get; set; } = DateTime.MinValue;
    public long Rows { get; set; }
    public HashSet<string> Services { get; set; } = new(StringComparer.Ordinal);
    public byte MaxSeverity { get; set; }
    public bool HasExceptions { get; set; }

    [JsonIgnore] public BloomFilter TraceIds { get; set; } = new();
    [JsonIgnore] public TrigramSet? Text { get; set; }

    public string? TraceIdsData { get => TraceIds.ToBase64(); set { if (value != null) TraceIds = BloomFilter.FromBase64(value); } }
    public string? TextData { get => Text?.ToBase64(); set { if (value != null) Text = TrigramSet.FromBase64(value); } }

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
        TraceIds.UnionWith(other.TraceIds);
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
