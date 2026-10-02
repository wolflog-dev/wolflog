namespace Wolflog.DemoDirectory;

/// <summary>
/// Annuaire LDAP de démonstration (Contoso), pour essayer la connexion LDAP / Active Directory de Wolflog sans serveur réel :
/// <c>dotnet run --project samples/Wolflog.DemoDirectory</c> (option <c>--port</c>, 10389 par défaut).
/// </summary>
internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var port = 10389;
        var option = Array.IndexOf(args, "--port");
        if (option >= 0 && (option + 1 >= args.Length || !int.TryParse(args[option + 1], out port)))
        {
            Console.Error.WriteLine("Usage : Wolflog.DemoDirectory [--port 10389]");
            return 1;
        }

        await using var server = LdapServer.Start(ContosoDirectory.Create(), IPAddress.Loopback, port,
            message => Console.WriteLine($"{DateTime.Now:HH:mm:ss}  {message}"));
        Console.WriteLine($"""
            Annuaire de démonstration Contoso : ldap://127.0.0.1:{server.Port} (sans chiffrement, accessible depuis cette machine seulement).
              DN de base         {ContosoDirectory.BaseDn}
              Compte de service  {ContosoDirectory.ServiceDn}
              Suffixe UPN        {ContosoDirectory.DnsName}
              Personnes          {string.Join(", ", ContosoDirectory.Accounts.Select(a => a.Login))}
            Mots de passe et réglages à saisir dans Wolflog : README.md de ce dossier. Ctrl+C pour arrêter.
            """);

        var stopped = new TaskCompletionSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stopped.TrySetResult();
        };
        await stopped.Task;
        return 0;
    }
}
