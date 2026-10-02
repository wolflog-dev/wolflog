using System.IO.Compression;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Testing;
using Wolflog.Server.Configuration;

namespace Wolflog.Tests;

/// <summary>Personnalisation : lecture publique, modification par un administrateur, contrôle et diffusion du logo, sauvegarde.</summary>
public class BrandingTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>PNG de 1 × 1 pixel.</summary>
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    /// <summary>SVG tel qu'en exportent les logiciels de dessin : en-tête, commentaire, DOCTYPE, dégradé, image embarquée.</summary>
    private const string Svg = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!-- Logo d'exemple -->
        <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 10">
          <defs><linearGradient id="g"><stop offset="0" stop-color="#0a66c2"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
          <style>.mot { font-family: 'Inter', sans-serif; fill: url('#g'); }</style>
          <rect width="40" height="10" rx="2" fill="url(#g)"/>
          <use xlink:href="#g"/>
          <image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/>
        </svg>
        """;

    private static async Task<JsonElement> Read(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<string> Refusal(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString()!;
    }

    /// <summary>Formulaire d'envoi ; le type annoncé est volontairement toujours image/png : seul le contenu compte.</summary>
    private static MultipartFormDataContent Upload(byte[] content, string fileName)
    {
        var file = new ByteArrayContent(content);
        file.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        return new MultipartFormDataContent { { file, "file", fileName } };
    }

    private async Task<HttpClient> Viewer()
    {
        var admin = await server.LoggedInClient();
        var name = "lecteur-" + Guid.NewGuid().ToString("N")[..6];
        var created = await Read(await admin.PostAsJsonAsync("/api/admin/users", new { username = name, role = "viewer" }));
        var viewer = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        var password = created.GetProperty("temporaryPassword").GetString();
        (await viewer.PostAsJsonAsync("/api/auth/login", new { username = name, password })).EnsureSuccessStatusCode();
        return viewer;
    }

    [Fact]
    public async Task Branding_is_public_and_only_admins_change_it()
    {
        var admin = await server.LoggedInClient();
        var saved = await Read(await admin.PutAsJsonAsync("/api/admin/branding", new
        {
            name = "  Acme Industries ", color = "#0A66C2", loginMessage = "Bienvenue chez Acme.\r\nUn accès ? support@acme.fr", forcePalette = true,
        }));
        Assert.Equal("Acme Industries", saved.GetProperty("name").GetString());
        Assert.Equal("#0a66c2", saved.GetProperty("color").GetString());
        Assert.Equal("admin", saved.GetProperty("updatedBy").GetString());

        // Lue sans être connecté (page de connexion), sans les informations réservées aux administrateurs.
        var anonymous = server.CreateClient();
        var seen = await Read(await anonymous.GetAsync("/api/branding"));
        Assert.Equal("Acme Industries", seen.GetProperty("name").GetString());
        Assert.Equal("#0a66c2", seen.GetProperty("color").GetString());
        Assert.Equal("Bienvenue chez Acme.\nUn accès ? support@acme.fr", seen.GetProperty("loginMessage").GetString());
        Assert.True(seen.GetProperty("forcePalette").GetBoolean());
        Assert.False(seen.TryGetProperty("updatedBy", out _));

        // Couleur courte acceptée ; couleur invalide, ou imposée sans couleur, refusée sans rien modifier.
        var shortColor = await Read(await admin.PutAsJsonAsync("/api/admin/branding", new { name = "Acme", color = "abc" }));
        Assert.Equal("#aabbcc", shortColor.GetProperty("color").GetString());
        Assert.False(shortColor.GetProperty("forcePalette").GetBoolean());
        Assert.Contains("#RRGGBB", await Refusal(await admin.PutAsJsonAsync("/api/admin/branding", new { name = "Autre", color = "bleu" })));
        Assert.Contains("couleur", await Refusal(await admin.PutAsJsonAsync("/api/admin/branding", new { name = "Autre", forcePalette = true })));
        Assert.Contains("60", await Refusal(await admin.PutAsJsonAsync("/api/admin/branding", new { name = new string('A', 61) })));

        // Modification : administrateurs seulement.
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PutAsJsonAsync("/api/admin/branding", new { name = "Pirate" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/api/admin/branding/logo", Upload(Png, "logo.png"))).StatusCode);
        var viewer = await Viewer();
        Assert.Equal("Acme", (await Read(await viewer.GetAsync("/api/branding"))).GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.GetAsync("/api/admin/branding")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PutAsJsonAsync("/api/admin/branding", new { name = "Pirate" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync("/api/admin/branding/logo", Upload(Png, "logo.png"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.DeleteAsync("/api/admin/branding/logo")).StatusCode);
        Assert.Equal("Acme", (await Read(await anonymous.GetAsync("/api/branding"))).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Logo_must_be_a_small_png_jpeg_webp_or_safe_svg()
    {
        var admin = await server.LoggedInClient();
        Task<HttpResponseMessage> Send(byte[] content, string fileName) => admin.PostAsync("/api/admin/branding/logo", Upload(content, fileName));

        // Le type se lit dans le contenu : un texte nommé .png, un GIF sont refusés.
        Assert.Contains("Format non reconnu", await Refusal(await Send("Ceci n'est pas une image"u8.ToArray(), "logo.png")));
        Assert.Contains("Format non reconnu", await Refusal(await Send("GIF89a"u8.ToArray(), "logo.gif")));
        // 1 Mo au plus.
        var large = new byte[1024 * 1024 + 1];
        Png.CopyTo(large, 0);
        Assert.Contains("1 Mo", await Refusal(await Send(large, "grand.png")));
        // SVG qui exécuterait du code.
        var script = Encoding.UTF8.GetBytes("""<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>""");
        Assert.Contains("SVG refusé", await Refusal(await Send(script, "logo.svg")));

        // PNG valide : accepté, quel que soit le chemin envoyé avec son nom.
        var saved = await Read(await Send(Png, @"C:\fakepath\acme.png"));
        Assert.True(saved.GetProperty("hasLogo").GetBoolean());
        Assert.Equal("image/png", saved.GetProperty("logoContentType").GetString());
        Assert.Equal("acme.png", saved.GetProperty("logoFileName").GetString());
        Assert.Equal(Png.Length, saved.GetProperty("logoSize").GetInt64());
    }

    [Theory]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>texte</p></foreignObject></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><image href="https://exemple.com/pistage.png"/></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="autre.svg#logo"/></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><style>@import 'https://exemple.com/a.css';</style></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill: url('https://exemple.com/a.svg#p')"/></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>""")]
    [InlineData("""<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript&#58;alert(1)"/><rect/></a></svg>""")]
    [InlineData("""<!DOCTYPE svg [<!ENTITY s "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg xmlns="http://www.w3.org/2000/svg">&s;</svg>""")]
    [InlineData("""<html><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>""")]
    public void Active_or_foreign_svg_is_refused(string svg) => Assert.Null(BrandingLogo.Check(Encoding.UTF8.GetBytes(svg)).ContentType);

    [Fact]
    public void Svg_from_drawing_software_is_accepted() => Assert.Equal(BrandingLogo.Svg, BrandingLogo.Check(Encoding.UTF8.GetBytes(Svg)).ContentType);

    [Fact]
    public async Task Png_logo_is_served_with_its_type_and_cached_by_version()
    {
        var admin = await server.LoggedInClient();
        var url = (await Read(await admin.PostAsync("/api/admin/branding/logo", Upload(Png, "acme.png")))).GetProperty("logoUrl").GetString()!;
        Assert.StartsWith("/api/branding/logo?v=", url);

        var anonymous = server.CreateClient();
        Assert.Equal(url, (await Read(await anonymous.GetAsync("/api/branding"))).GetProperty("logoUrl").GetString());
        var logo = await anonymous.GetAsync(url);
        logo.EnsureSuccessStatusCode();
        Assert.Equal("image/png", logo.Content.Headers.ContentType?.MediaType);
        Assert.Equal("nosniff", Assert.Single(logo.Headers.GetValues("X-Content-Type-Options")));
        Assert.True(logo.Headers.CacheControl?.Public);
        Assert.Equal(TimeSpan.FromDays(365), logo.Headers.CacheControl?.MaxAge);
        Assert.Equal(Png, await logo.Content.ReadAsByteArrayAsync());
        // Sans version (ou avec une version dépassée) : pas de cache longue durée.
        Assert.True((await anonymous.GetAsync("/api/branding/logo")).Headers.CacheControl?.NoCache);
    }

    [Fact]
    public async Task Svg_logo_is_served_with_a_content_security_policy()
    {
        var admin = await server.LoggedInClient();
        var saved = await Read(await admin.PostAsync("/api/admin/branding/logo", Upload(Encoding.UTF8.GetBytes(Svg), "acme.svg")));
        Assert.Equal(BrandingLogo.Svg, saved.GetProperty("logoContentType").GetString());
        var url = saved.GetProperty("logoUrl").GetString();

        var anonymous = server.CreateClient();
        var logo = await anonymous.GetAsync(url);
        logo.EnsureSuccessStatusCode();
        Assert.Equal(BrandingLogo.Svg, logo.Content.Headers.ContentType?.MediaType);
        Assert.Equal("default-src 'none'; style-src 'unsafe-inline'", Assert.Single(logo.Headers.GetValues("Content-Security-Policy")));
        Assert.Equal("nosniff", Assert.Single(logo.Headers.GetValues("X-Content-Type-Options")));

        // Déjà dans le cache du navigateur : rien à renvoyer.
        using var again = new HttpRequestMessage(HttpMethod.Get, url);
        again.Headers.IfNoneMatch.Add(logo.Headers.ETag!);
        Assert.Equal(HttpStatusCode.NotModified, (await anonymous.SendAsync(again)).StatusCode);
    }

    [Fact]
    public async Task Logo_can_be_removed()
    {
        var admin = await server.LoggedInClient();
        var url = (await Read(await admin.PostAsync("/api/admin/branding/logo", Upload(Png, "acme.png")))).GetProperty("logoUrl").GetString();

        var removed = await Read(await admin.DeleteAsync("/api/admin/branding/logo"));
        Assert.False(removed.GetProperty("hasLogo").GetBoolean());
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("logoUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("logoFileName").ValueKind);
        var anonymous = server.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await anonymous.GetAsync(url)).StatusCode);
        Assert.False((await Read(await anonymous.GetAsync("/api/branding"))).GetProperty("hasLogo").GetBoolean());
        // Sans logo : rien à retirer, pas d'erreur.
        (await admin.DeleteAsync("/api/admin/branding/logo")).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Branding_and_logo_are_saved_and_restored_with_the_configuration()
    {
        var admin = await server.LoggedInClient();
        await Read(await admin.PutAsJsonAsync("/api/admin/branding", new { name = "Sauvegardée", color = "#16a34a" }));
        await Read(await admin.PostAsync("/api/admin/branding/logo", Upload(Png, "acme.png")));

        var backup = await admin.GetAsync("/api/admin/backup");
        backup.EnsureSuccessStatusCode();
        var bytes = await backup.Content.ReadAsByteArrayAsync();
        using (var zip = new ZipArchive(new MemoryStream(bytes)))
        {
            Assert.Contains(zip.Entries, e => e.FullName == "config/branding.json");
            using var logo = new MemoryStream();
            using (var entry = Assert.Single(zip.Entries, e => e.FullName == "config/" + BrandingStore.LogoFile).Open()) entry.CopyTo(logo);
            Assert.Equal(Png, logo.ToArray());
        }

        // Logo retiré et nom changé, puis restauration : tout revient.
        await Read(await admin.DeleteAsync("/api/admin/branding/logo"));
        await Read(await admin.PutAsJsonAsync("/api/admin/branding", new { name = "Modifiée" }));
        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", "sauvegarde.zip" } };
        (await admin.PostAsync("/api/admin/restore", form)).EnsureSuccessStatusCode();
        var anonymous = server.CreateClient();
        var restored = await Read(await anonymous.GetAsync("/api/branding"));
        Assert.Equal("Sauvegardée", restored.GetProperty("name").GetString());
        Assert.Equal("#16a34a", restored.GetProperty("color").GetString());
        Assert.Equal(Png, await anonymous.GetByteArrayAsync(restored.GetProperty("logoUrl").GetString()));
    }
}
