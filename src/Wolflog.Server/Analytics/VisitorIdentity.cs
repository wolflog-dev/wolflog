using System.Security.Cryptography;

namespace Wolflog.Server.Analytics;

/// <summary>
/// Visiteurs anonymes, sans cookie : empreinte SHA-256 (sel + service + IP + navigateur).
/// Le sel change chaque jour et l'ancien est détruit : un visiteur ne peut pas être suivi d'un jour à l'autre,
/// et l'IP n'est jamais stockée. Une visite se termine après 30 minutes d'inactivité.
/// </summary>
public sealed class VisitorIdentity(StorageHost storage)
{
    private static readonly TimeSpan VisitTimeout = TimeSpan.FromMinutes(30);
    private readonly ConcurrentDictionary<string, (string Visit, DateTime Last)> _visits = new();
    private readonly Lock _saltLock = new();
    private byte[] _salt = [];
    private string _saltDay = "";
    private DateTime _lastPrune = DateTime.UtcNow;

    private sealed record SaltFile(string Day, string Salt);

    private string SaltPath => Path.Combine(storage.DataDirectory, "analytics-salt.json");

    private byte[] Salt(DateTime now)
    {
        var day = now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (day == _saltDay) return _salt;
        lock (_saltLock)
        {
            if (day == _saltDay) return _salt;
            SaltFile? saved = null;
            try { if (File.Exists(SaltPath)) saved = JsonSerializer.Deserialize<SaltFile>(File.ReadAllBytes(SaltPath)); }
            catch (Exception ex) when (ex is IOException or JsonException) { saved = null; }
            if (saved?.Day == day)
            {
                _salt = Convert.FromBase64String(saved.Salt);
            }
            else
            {
                // Le sel de la veille est écrasé : les empreintes passées deviennent impossibles à recalculer.
                _salt = RandomNumberGenerator.GetBytes(32);
                File.WriteAllBytes(SaltPath, JsonSerializer.SerializeToUtf8Bytes(new SaltFile(day, Convert.ToBase64String(_salt))));
            }
            _saltDay = day;
            return _salt;
        }
    }

    /// <summary>Identifiant anonyme du visiteur pour la journée en cours.</summary>
    public string Visitor(string service, string? ip, string? userAgent, DateTime now)
    {
        using var hash = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, Salt(now));
        hash.AppendData(Encoding.UTF8.GetBytes($"{service}\n{ip}\n{userAgent}"));
        return Convert.ToHexStringLower(hash.GetHashAndReset())[..16];
    }

    /// <summary>Visite en cours du visiteur (nouvelle après 30 minutes sans activité).</summary>
    public string Visit(string visitor, DateTime now)
    {
        if (now - _lastPrune > TimeSpan.FromMinutes(5))
        {
            _lastPrune = now;
            foreach (var (key, v) in _visits)
                if (now - v.Last > VisitTimeout) _visits.TryRemove(key, out _);
        }
        var current = _visits.AddOrUpdate(visitor,
            _ => (NewVisit(), now),
            (_, v) => now - v.Last > VisitTimeout ? (NewVisit(), now) : (v.Visit, now > v.Last ? now : v.Last));
        return current.Visit;
    }

    private static string NewVisit() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
}
