namespace Wolflog.Server.Security;

public sealed class UserStore(string dataDirectory) : JsonCollection<User>(dataDirectory, "users.json")
{
    public User? ByUsername(string username) =>
        Find(u => string.Equals(u.Username, username, StringComparison.OrdinalIgnoreCase));

    public User? Verify(string username, string password)
    {
        var user = ByUsername(username);
        if (user is null || user.Disabled || user.Source != "local") return null;
        if (!Passwords.Verify(password, user.PasswordHash)) return null;
        return Update(user.Id, u => u.LastLoginAt = DateTime.UtcNow);
    }
}
