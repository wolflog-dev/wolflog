using Wolflog.DemoDirectory;
using Wolflog.Server.Security;

namespace Wolflog.Tests;

/// <summary>
/// Connexion par l'annuaire LDAP / Active Directory, avec le vrai client LDAP contre l'annuaire de démonstration Contoso :
/// UPN, nom de compte et DOMAINE\compte, groupes (imbriqués compris) → rôle et profil, comptes refusés, injection,
/// priorité des comptes locaux, mot de passe du compte de service jamais renvoyé, tests de l'administration.
/// </summary>
public class LdapTests(SsoServerFixture server, DemoDirectoryFixture directory) : IClassFixture<SsoServerFixture>, IClassFixture<DemoDirectoryFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static DemoAccount Account(string login) => ContosoDirectory.Accounts.Single(a => a.Login == login);

    /// <summary>Réglages de la page : annuaire Contoso (avec ou sans compte de service), groupes → rôles et profils.</summary>
    private object Settings(bool serviceAccount = true, string? servicePassword = ContosoDirectory.ServicePassword, string? hosts = null,
        string? usernameAttribute = null) => new
    {
        microsoftEnabled = false,
        windowsEnabled = false,
        autoSignIn = "",
        allowedDomains = Array.Empty<string>(),
        defaultRole = "viewer",
        defaultProfileId = (string?)null,
        groupMappings = new object[]
        {
            new { group = "Wolflog-Admins", role = "admin", profileId = (string?)null },
            new { group = "wolflog-exploitation", role = "editor", profileId = "ops" },
            // Par le DN complet : Sophie Bernard en est membre par le groupe imbriqué Equipe-Web.
            new { group = ContosoDirectory.GroupDn("Wolflog-Produit"), role = (string?)null, profileId = "product" },
        },
        ldap = new
        {
            enabled = true,
            kind = "ad",
            label = "Contoso",
            hosts = hosts ?? $"127.0.0.1:{directory.Server.Port}",
            port = 389,
            security = "none",
            ignoreCertificateErrors = false,
            baseDn = ContosoDirectory.BaseDn,
            bindDn = serviceAccount ? ContosoDirectory.ServiceDn : null,
            bindPassword = serviceAccount ? servicePassword : null,
            upnSuffix = ContosoDirectory.DnsName,
            userFilter = (string?)null,
            usernameAttribute,
            displayNameAttribute = (string?)null,
            mailAttribute = (string?)null,
            groupAttribute = (string?)null,
            nestedGroups = true,
        },
    };

    private Task<HttpClient> Admin() => server.Login("admin", SsoServerFixture.Password);

    private async Task Configure(bool serviceAccount = true)
    {
        var admin = await Admin();
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(serviceAccount))).EnsureSuccessStatusCode();
    }

    /// <summary>Connexion par le formulaire, puis ce que /api/auth/me dit de la session.</summary>
    private async Task<(HttpResponseMessage Response, JsonElement Me)> SignIn(string username, string password)
    {
        var browser = server.Browser();
        var response = await browser.PostAsJsonAsync("/api/auth/login", new { username, password });
        var me = await (await browser.GetAsync("/api/auth/me")).Content.ReadFromJsonAsync<JsonElement>(Json);
        return (response, me);
    }

    private static async Task<string?> Error(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>(Json)).TryGetProperty("error", out var error) ? error.GetString() : null;

    private async Task<string[]> UserNames()
    {
        var users = await (await (await Admin()).GetAsync("/api/admin/users")).Content.ReadFromJsonAsync<JsonElement>(Json);
        return [.. users.EnumerateArray().Select(u => u.GetProperty("username").GetString()!).Order(StringComparer.Ordinal)];
    }

    [Fact]
    public async Task Directory_accounts_sign_in_with_upn_or_account_name_and_get_roles_from_groups()
    {
        await Configure();

        var (signedIn, me) = await SignIn("jdupont@contoso.local", Account("jdupont").Password);
        Assert.Equal(HttpStatusCode.OK, signedIn.StatusCode);
        Assert.Equal("jdupont@contoso.local", me.GetProperty("user").GetString());
        Assert.Equal("Jeanne Dupont", me.GetProperty("displayName").GetString());
        Assert.Equal("admin", me.GetProperty("role").GetString());
        Assert.Equal("ldap", me.GetProperty("source").GetString());

        // Nom de compte seul : rôle et profil du groupe Wolflog-Exploitation, désigné par son nom court (casse indifférente).
        var (_, ops) = await SignIn("lpetit", Account("lpetit").Password);
        Assert.Equal("lpetit@contoso.local", ops.GetProperty("user").GetString());
        Assert.Equal("editor", ops.GetProperty("role").GetString());
        Assert.Equal("ops", ops.GetProperty("profile").GetProperty("id").GetString());

        // DOMAINE\compte ; groupe imbriqué (Equipe-Web, membre de Wolflog-Produit) désigné par son DN : profil Produit.
        var (_, product) = await SignIn(@"CONTOSO\sbernard", Account("sbernard").Password);
        Assert.Equal("sbernard@contoso.local", product.GetProperty("user").GetString());
        Assert.Equal("viewer", product.GetProperty("role").GetString());
        Assert.Equal("product", product.GetProperty("profile").GetProperty("id").GetString());

        // Sans groupe correspondant : rôle par défaut.
        var (_, plain) = await SignIn("pmartin@contoso.local", Account("pmartin").Password);
        Assert.Equal("viewer", plain.GetProperty("role").GetString());
    }

    [Fact]
    public async Task Without_service_account_active_directory_is_reached_with_the_upn()
    {
        await Configure(serviceAccount: false);

        var (signedIn, me) = await SignIn("lpetit", Account("lpetit").Password);
        Assert.Equal(HttpStatusCode.OK, signedIn.StatusCode);
        Assert.Equal("lpetit@contoso.local", me.GetProperty("user").GetString());
        Assert.Equal("editor", me.GetProperty("role").GetString());
        Assert.Equal(HttpStatusCode.OK, (await SignIn(@"CONTOSO\jdupont", Account("jdupont").Password)).Response.StatusCode);

        // Compte désactivé : l'annuaire refuse la liaison (data 533), message sans rien révéler.
        var (disabled, _) = await SignIn("mdurand", Account("mdurand").Password);
        Assert.Equal(HttpStatusCode.Unauthorized, disabled.StatusCode);
        Assert.Equal(PasswordSignIn.WrongCredentials, await Error(disabled));

        // Mot de passe vide : refusé avant toute liaison (l'annuaire, comme Active Directory, l'accepterait en anonyme).
        var (empty, emptyMe) = await SignIn("lpetit", "");
        Assert.Equal(HttpStatusCode.Unauthorized, empty.StatusCode);
        Assert.False(emptyMe.GetProperty("authenticated").GetBoolean());
    }

    [Fact]
    public async Task Disabled_accounts_bad_or_empty_passwords_and_injection_are_refused()
    {
        await Configure();
        var before = await UserNames();

        // Compte désactivé (userAccountControl), mauvais mot de passe : même message, qui ne trahit pas l'existence du compte.
        var (disabled, _) = await SignIn("mdurand", Account("mdurand").Password);
        Assert.Equal(HttpStatusCode.Unauthorized, disabled.StatusCode);
        Assert.Equal(PasswordSignIn.WrongCredentials, await Error(disabled));
        var (wrong, _) = await SignIn("jdupont", "mauvais-mot-de-passe");
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        Assert.Equal(PasswordSignIn.WrongCredentials, await Error(wrong));

        var (empty, emptyMe) = await SignIn("jdupont", "");
        Assert.Equal(HttpStatusCode.Unauthorized, empty.StatusCode);
        Assert.False(emptyMe.GetProperty("authenticated").GetBoolean());

        // Caractères spéciaux échappés (RFC 4515) : aucun de ces identifiants ne désigne jdupont, même avec son mot de passe.
        foreach (var injection in new[] { "jdupon*", "*", "jd*nt", "jdupont)(objectClass=*", "*)(sAMAccountName=jdupont" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await SignIn(injection, Account("jdupont").Password)).Response.StatusCode);

        // Mot de passe à changer (data 773) : un message utile.
        var (expired, _) = await SignIn("lmoreau", Account("lmoreau").Password);
        Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);
        Assert.Contains("doit être changé", await Error(expired));

        Assert.Equal(before, await UserNames());
    }

    [Fact]
    public async Task Local_accounts_keep_priority_over_the_directory()
    {
        await Configure();

        // L'administrateur local, compte de secours, reste toujours disponible.
        Assert.Equal(HttpStatusCode.OK, (await SignIn("admin", SsoServerFixture.Password)).Response.StatusCode);

        // Compte local du même nom qu'une personne de l'annuaire : seul son mot de passe Wolflog l'ouvre, jamais l'annuaire.
        var created = await (await (await Admin()).PostAsJsonAsync("/api/admin/users", new { username = "pmartin", role = "viewer" }))
            .Content.ReadFromJsonAsync<JsonElement>(Json);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SignIn("pmartin", Account("pmartin").Password)).Response.StatusCode);
        var (local, me) = await SignIn("pmartin", created.GetProperty("temporaryPassword").GetString()!);
        Assert.Equal(HttpStatusCode.OK, local.StatusCode);
        Assert.Equal("local", me.GetProperty("source").GetString());
    }

    [Fact]
    public async Task Directory_sign_in_never_takes_over_a_local_account_even_with_a_directory_name()
    {
        // Identifiant Wolflog = e-mail de l'annuaire (pmartin@contoso.fr), et un compte local porte déjà ce nom.
        var admin = await Admin();
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(usernameAttribute: "mail"))).EnsureSuccessStatusCode();
        var created = await (await admin.PostAsJsonAsync("/api/admin/users", new { username = "pmartin@contoso.fr", role = "viewer" }))
            .Content.ReadFromJsonAsync<JsonElement>(Json);

        // L'annuaire reconnaît Paul Martin, mais Wolflog refuse de lui donner le compte local.
        var (refused, refusedMe) = await SignIn(@"CONTOSO\pmartin", Account("pmartin").Password);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Contains("compte Wolflog local", await Error(refused));
        Assert.False(refusedMe.GetProperty("authenticated").GetBoolean());

        // Le compte local reste intact : seul son mot de passe Wolflog l'ouvre.
        var (local, me) = await SignIn("pmartin@contoso.fr", created.GetProperty("temporaryPassword").GetString()!);
        Assert.Equal(HttpStatusCode.OK, local.StatusCode);
        Assert.Equal("local", me.GetProperty("source").GetString());
        await Configure();
    }

    [Fact]
    public async Task Service_account_password_never_leaves_the_server()
    {
        var admin = await Admin();
        var saved = await admin.PutAsJsonAsync("/api/admin/sso", Settings());
        saved.EnsureSuccessStatusCode();
        Assert.DoesNotContain(ContosoDirectory.ServicePassword, await saved.Content.ReadAsStringAsync());
        var view = await admin.GetStringAsync("/api/admin/sso");
        Assert.DoesNotContain(ContosoDirectory.ServicePassword, view);
        var ldap = JsonSerializer.Deserialize<JsonElement>(view, Json).GetProperty("settings").GetProperty("ldap");
        Assert.True(ldap.GetProperty("hasBindPassword").GetBoolean());
        Assert.False(ldap.TryGetProperty("protectedBindPassword", out _));
        Assert.DoesNotContain(ContosoDirectory.ServicePassword, await File.ReadAllTextAsync(Path.Combine(server.DataDirectory, "sso.json")));

        // Enregistré sans mot de passe : celui enregistré est conservé, la connexion fonctionne toujours.
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(servicePassword: null))).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.OK, (await SignIn("jdupont", Account("jdupont").Password)).Response.StatusCode);

        // Vers d'autres serveurs, il n'est jamais envoyé (ni test, ni enregistrement) : il faut le saisir de nouveau.
        var elsewhere = Settings(servicePassword: null, hosts: $"localhost:{directory.Server.Port}");
        foreach (var attempt in new[] { await admin.PostAsJsonAsync("/api/admin/sso/ldap/test", new { settings = elsewhere }), await admin.PutAsJsonAsync("/api/admin/sso", elsewhere) })
        {
            Assert.Equal(HttpStatusCode.BadRequest, attempt.StatusCode);
            Assert.Contains("Saisissez de nouveau le mot de passe", (await attempt.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString());
        }
        Assert.Equal(HttpStatusCode.OK, (await SignIn("lpetit", Account("lpetit").Password)).Response.StatusCode);

        // La page de connexion apprend que le formulaire accepte l'identifiant de l'entreprise.
        var sso = (await (await server.Browser().GetAsync("/api/auth/me")).Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("sso");
        Assert.True(sso.GetProperty("ldap").GetBoolean());
        Assert.Equal("Contoso", sso.GetProperty("ldapLabel").GetString());
        Assert.Equal("contoso.local", sso.GetProperty("ldapDomain").GetString());
        Assert.False(sso.GetProperty("microsoft").GetBoolean());
    }

    [Fact]
    public async Task Administrators_test_the_connection_and_an_account_without_creating_it()
    {
        var admin = await Admin();
        async Task<JsonElement> Post(string url, object body)
        {
            var response = await admin.PostAsJsonAsync(url, body);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
        }

        var probe = await Post("/api/admin/sso/ldap/test", new { settings = Settings() });
        Assert.True(probe.GetProperty("ok").GetBoolean());
        Assert.Equal(ContosoDirectory.BaseDn, probe.GetProperty("baseDn").GetString());
        Assert.Contains("DemoDirectory", probe.GetProperty("server").GetString());

        var refused = await Post("/api/admin/sso/ldap/test", new { settings = Settings(servicePassword: "faux") });
        Assert.False(refused.GetProperty("ok").GetBoolean());
        Assert.Contains(refused.GetProperty("steps").EnumerateArray(), s => s.GetProperty("title").GetString() == "Compte de service" && s.GetProperty("ok").GetBoolean() == false);

        var unreachable = await Post("/api/admin/sso/ldap/test", new { settings = Settings(hosts: "127.0.0.1:1") });
        Assert.False(unreachable.GetProperty("ok").GetBoolean());
        Assert.Contains("injoignable", unreachable.GetProperty("steps")[0].GetProperty("message").GetString());

        // Compte d'une personne : DN, e-mail, groupes (imbriqués compris), rôle et profil prévus ; aucun compte créé.
        var before = await UserNames();
        var tested = await Post("/api/admin/sso/ldap/account", new { settings = Settings(), username = "sbernard", password = Account("sbernard").Password });
        Assert.True(tested.GetProperty("ok").GetBoolean());
        var account = tested.GetProperty("account");
        Assert.Equal(ContosoDirectory.UserDn(Account("sbernard")), account.GetProperty("dn").GetString());
        Assert.Equal("sbernard@contoso.fr", account.GetProperty("email").GetString());
        // Groupes par nom court, avec leur DN ; Wolflog-Produit (correspondance par DN) est repris, Equipe-Web non.
        var groups = account.GetProperty("groups").EnumerateArray().ToDictionary(g => g.GetProperty("name").GetString()!, g => g.GetProperty("mapped").GetBoolean());
        Assert.False(groups["Equipe-Web"]);
        Assert.True(groups["Wolflog-Produit"]);
        Assert.Equal(ContosoDirectory.GroupDn("Wolflog-Produit"),
            account.GetProperty("groups").EnumerateArray().Single(g => g.GetProperty("name").GetString() == "Wolflog-Produit").GetProperty("dn").GetString());
        Assert.Equal("viewer", tested.GetProperty("decision").GetProperty("role").GetString());
        Assert.Equal("product", tested.GetProperty("decision").GetProperty("profileId").GetString());
        Assert.Equal(before, await UserNames());

        var denied = await Post("/api/admin/sso/ldap/account", new { settings = Settings(), username = "sbernard", password = "faux" });
        Assert.False(denied.GetProperty("ok").GetBoolean());
        Assert.Contains("refusé", denied.GetProperty("message").GetString());
    }

    [Fact]
    public void Filter_values_are_escaped_and_group_names_read_from_their_dn()
    {
        Assert.Equal(@"jd\2a\28x\29\5c\00", LdapDirectory.EscapeFilterValue("jd*(x)\\\0"));
        Assert.Equal("Wolflog-Admins", LdapDirectory.CommonName("CN=Wolflog-Admins,OU=Groupes,DC=contoso,DC=local"));
        Assert.Equal("Dupont, Jeanne", LdapDirectory.CommonName(@"CN=Dupont\, Jeanne,OU=Utilisateurs,DC=contoso,DC=local"));
        Assert.Equal("Dupont, Jeanne", LdapDirectory.CommonName(@"CN=Dupont\2C Jeanne,OU=Utilisateurs,DC=contoso,DC=local"));
        Assert.Null(LdapDirectory.Servers("ldap://exemple.org:abc", 389));
        Assert.Equal(new List<(string Host, int Port)> { ("dc1.contoso.local", 636), ("10.0.0.2", 3269) },
            LdapDirectory.Servers("ldaps://dc1.contoso.local, 10.0.0.2:3269", 636));
    }
}
