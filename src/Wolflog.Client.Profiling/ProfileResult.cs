namespace Wolflog.Client.Profiling;

/// <summary>Résultat d'un profil : piles agrégées (« racine;…;feuille » → poids).</summary>
public sealed record ProfileResult(string Kind, DateTime Start, double Seconds, long Samples, IReadOnlyDictionary<string, long> Stacks);
