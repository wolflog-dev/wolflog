internal sealed record OrderSearch(CustomerFilter? Customer, DateRange? CreatedAt, Range<decimal>? Amount, string[]? Tags, string[]? Channels, SearchOptions? Options)
{
    public int CountFilters() => new object?[] { Customer, CreatedAt, Amount, Tags, Channels }.Count(x => x != null);
}
