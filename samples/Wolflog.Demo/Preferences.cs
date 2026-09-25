internal sealed record Preferences(string Language, bool Newsletter, string[] Channels, Dictionary<string, bool> Notifications);
