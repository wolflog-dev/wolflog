namespace Wolflog.Server.Ingestion;

/// <summary>Contenu reçu plus gros que permis une fois décompressé (réponse 413).</summary>
public sealed class PayloadTooLargeException(long maxBytes)
    : IOException($"Contenu trop volumineux une fois décompressé (plus de {maxBytes / 1024 / 1024} Mo).")
{
    public long MaxBytes { get; } = maxBytes;
}
