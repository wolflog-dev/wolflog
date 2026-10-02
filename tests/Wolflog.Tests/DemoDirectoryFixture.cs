using Wolflog.DemoDirectory;

namespace Wolflog.Tests;

/// <summary>Annuaire de démonstration Contoso, démarré sur un port libre de 127.0.0.1 : le vrai client LDAP, en vrai TCP.</summary>
public sealed class DemoDirectoryFixture : IAsyncDisposable
{
    public LdapServer Server { get; } = LdapServer.Start(ContosoDirectory.Create(), IPAddress.Loopback, 0);

    public ValueTask DisposeAsync() => Server.DisposeAsync();
}
