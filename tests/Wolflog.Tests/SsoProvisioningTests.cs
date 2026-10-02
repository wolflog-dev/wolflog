using System.Security.Claims;
using Wolflog.Server;
using Wolflog.Server.Security;

namespace Wolflog.Tests;

/// <summary>
/// Comptes créés ou mis à jour à la connexion unique : correspondances de groupes (rôle, profil d'accès), domaines
/// autorisés, comptes désactivés ou locaux, identité lue dans le jeton ou la session Windows.
/// </summary>
public sealed class SsoProvisioningTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly UserStore _users;
    private readonly string _localAdmin;

    private static readonly SsoGroupMapping[] Mappings =
    [
        new() { Group = "g-admins", Role = Roles.Admin },
        new() { Group = "g-editors", Role = Roles.Editor },
        new() { Group = "g-support", Name = "Support", ProfileId = "profil-support" },
    ];

    public SsoProvisioningTests()
    {
        _users = new UserStore(_dir.Path);
        // Comme au premier démarrage : un administrateur local.
        _localAdmin = _users.Upsert(new User { Username = "admin", Role = Roles.Admin, PasswordHash = Passwords.Hash("mot-de-passe-local") }).Id;
    }

    public void Dispose() => _dir.Dispose();

    private static DirectoryIdentity Identity(string username, params string[] groups) =>
        new("microsoft", username, null, null, groups.ToHashSet(StringComparer.OrdinalIgnoreCase));

    private static SsoProvisioning.Rules Rules(params string[] domains) => new(Roles.Viewer, "profil-lecture", domains, Mappings, FollowDirectory: true);

    private SsoProvisioning.Result Provision(DirectoryIdentity identity, SsoProvisioning.Rules rules) => SsoProvisioning.Provision(_users, identity, rules);

    [Fact]
    public void Groups_give_the_highest_role_and_a_profile_and_follow_the_directory()
    {
        var alice = Provision(Identity("alice@contoso.fr", "G-EDITORS", "g-admins", "g-support"), Rules()).User!;
        Assert.Equal(Roles.Admin, alice.Role);
        Assert.Equal("profil-support", alice.ProfileId);
        Assert.Equal("sso", alice.Source);
        Assert.Equal("alice", alice.DisplayName);
        Assert.NotNull(alice.LastLoginAt);

        var bob = Provision(Identity("bob@contoso.fr"), Rules()).User!;
        Assert.Equal(Roles.Viewer, bob.Role);
        Assert.Equal("profil-lecture", bob.ProfileId);

        // Alice ne fait plus partie que des éditeurs : son rôle et son profil suivent dès la connexion suivante.
        var again = Provision(Identity("alice@contoso.fr", "g-editors"), Rules()).User!;
        Assert.Equal(alice.Id, again.Id);
        Assert.Equal(Roles.Editor, again.Role);
        Assert.Equal("profil-lecture", again.ProfileId);
        Assert.Single(_users.All(), u => u.Username == "alice@contoso.fr");
    }

    [Fact]
    public void Without_role_mappings_the_role_chosen_in_wolflog_is_kept()
    {
        var rules = new SsoProvisioning.Rules(Roles.Viewer, null, [], [new SsoGroupMapping { Group = "g-support", ProfileId = "profil-support" }], FollowDirectory: true);
        var carol = Provision(Identity("carol@contoso.fr"), rules).User!;
        _users.Update(carol.Id, u => u.Role = Roles.Editor);
        Assert.Equal(Roles.Editor, Provision(Identity("carol@contoso.fr"), rules).User!.Role);
    }

    [Fact]
    public void Wolflog_json_groups_win_but_never_take_a_role_back()
    {
        var rules = OidcSignIn.FileRules(new WolflogServerOptions.OidcOptions { DefaultRole = "viewer", AdminGroups = ["g-admins"], EditorGroups = ["g-editors"] });
        Assert.Equal(Roles.Admin, Provision(Identity("dan@contoso.fr", "g-admins", "g-editors"), rules).User!.Role);
        Assert.Equal(Roles.Admin, Provision(Identity("dan@contoso.fr"), rules).User!.Role);
    }

    [Fact]
    public void The_last_active_administrator_is_never_demoted()
    {
        _users.Update(_localAdmin, u => u.Disabled = true);
        Assert.Equal(Roles.Admin, Provision(Identity("grace@contoso.fr", "g-admins"), Rules()).User!.Role);
        Assert.Equal(Roles.Admin, Provision(Identity("grace@contoso.fr"), Rules()).User!.Role);

        _users.Update(_localAdmin, u => u.Disabled = false);
        Assert.Equal(Roles.Viewer, Provision(Identity("grace@contoso.fr"), Rules()).User!.Role);
    }

    [Fact]
    public void Allowed_domains_check_the_upn_or_the_windows_domain()
    {
        var rules = Rules("contoso.fr", "contoso");
        Assert.NotNull(Provision(Identity("eve@CONTOSO.fr"), rules).User);
        Assert.NotNull(Provision(Identity(@"CONTOSO\eve"), rules).User);
        Assert.Equal(SsoProvisioning.Domain, Provision(Identity("mallory@fabrikam.com"), rules).Refusal);
        Assert.Equal(SsoProvisioning.Domain, Provision(Identity(@"FABRIKAM\mallory"), rules).Refusal);
        Assert.Equal(SsoProvisioning.Domain, Provision(Identity("sans-domaine"), rules).Refusal);
        Assert.DoesNotContain(_users.All(), u => u.Username.Contains("mallory", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Disabled_accounts_and_local_accounts_are_refused()
    {
        var frank = Provision(Identity("frank@contoso.fr"), Rules()).User!;
        _users.Update(frank.Id, u => { u.Disabled = true; u.LastLoginAt = null; });
        var refused = Provision(Identity("frank@contoso.fr", "g-admins"), Rules());
        Assert.Null(refused.User);
        Assert.Equal(SsoProvisioning.Disabled, refused.Refusal);
        Assert.Null(_users.Get(frank.Id)!.LastLoginAt);
        Assert.Equal(Roles.Viewer, _users.Get(frank.Id)!.Role);

        // Le compte local « admin » ne se rattache jamais à une identité de l'annuaire du même nom.
        Assert.Equal(SsoProvisioning.Conflict, Provision(Identity("admin", "g-admins"), Rules()).Refusal);
        // Un compte local créé avec un UPN, en revanche, est celui de la personne.
        var local = _users.Upsert(new User { Username = "henri@contoso.fr", Role = Roles.Editor, PasswordHash = Passwords.Hash("provisoire-123") });
        var linked = Provision(Identity("henri@contoso.fr"), Rules()).User!;
        Assert.Equal(local.Id, linked.Id);
        Assert.Equal("local", linked.Source);
    }

    [Fact]
    public void Identity_comes_from_stable_claims_or_the_windows_session()
    {
        var token = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("name", "Jeanne Dupont"), new Claim("preferred_username", "jdupont@contoso.fr"), new Claim("sub", "abc"),
            new Claim("groups", "g-1"), new Claim("groups", "g-2"), new Claim("roles", "Wolflog.Admin"),
        ], "oidc"));
        var fromToken = DirectoryIdentity.FromOidc("microsoft", token, "groups")!;
        Assert.Equal("jdupont@contoso.fr", fromToken.Username);
        Assert.Equal("Jeanne Dupont", fromToken.DisplayName);
        Assert.Equal("jdupont@contoso.fr", fromToken.Email);
        Assert.True(fromToken.Groups.SetEquals(["G-1", "g-2", "wolflog.admin"]));

        // Sans UPN ni e-mail : le sujet, jamais le nom affiché (ni unique, ni toujours maîtrisé par l'annuaire).
        var bare = DirectoryIdentity.FromOidc("oidc", new ClaimsPrincipal(new ClaimsIdentity([new Claim("name", "admin"), new Claim("sub", "u-42")], "oidc")), "groups")!;
        Assert.Equal("u-42", bare.Username);

        var session = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, @"CONTOSO\jdupont"), new Claim(ClaimTypes.Role, @"CONTOSO\Wolflog-Admins")], "Negotiate"));
        var fromWindows = DirectoryIdentity.FromWindows(session)!;
        Assert.Equal(@"CONTOSO\jdupont", fromWindows.Username);
        Assert.Equal("jdupont", fromWindows.AccountName);
        Assert.Contains(@"CONTOSO\Wolflog-Admins", fromWindows.Groups);
    }
}
