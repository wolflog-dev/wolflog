namespace Wolflog.Server.Security;

public static class Roles
{
    public const string Viewer = "viewer";
    public const string Editor = "editor";
    public const string Admin = "admin";

    public static bool IsValid(string? role) => role is Viewer or Editor or Admin;

    /// <summary>admin ⊃ editor ⊃ viewer.</summary>
    public static bool Allows(string? role, string required) => required switch
    {
        Admin => role == Admin,
        Editor => role is Admin or Editor,
        _ => IsValid(role),
    };
}
