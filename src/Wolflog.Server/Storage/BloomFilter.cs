using System.Numerics;

namespace Wolflog.Server.Storage;

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
