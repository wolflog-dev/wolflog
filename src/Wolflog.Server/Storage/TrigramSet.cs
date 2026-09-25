using System.Runtime.CompilerServices;

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
