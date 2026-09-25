namespace Wolflog.Server.Query;

public sealed record ErrorDetail(ErrorGroup Group, LogItem? Latest, IReadOnlyList<ErrorOccurrence> Occurrences, Histogram Histogram)
{
    public Configuration.ErrorState? State { get; init; }
}
