internal sealed record CustomerFilter(string? NameContains, string[]? Emails, string? Segment, bool? HasLoyaltyCard);
