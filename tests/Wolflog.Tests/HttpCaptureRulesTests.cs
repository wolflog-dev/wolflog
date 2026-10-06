using Wolflog.Client;

namespace Wolflog.Tests;

public class HttpCaptureRulesTests
{
    [Fact]
    public void Sensitive_json_and_form_fields_are_masked()
    {
        var rules = new HttpCaptureRules(new HttpCaptureOptions());
        var json = """{"user":"alice","Password":"s3cr3t","nested":{"access_token":"abc","n":1},"apiKey":42}""";
        var masked = rules.Format(Encoding.UTF8.GetBytes(json), json.Length, "application/json");
        Assert.Contains("\"user\":\"alice\"", masked);
        Assert.DoesNotContain("s3cr3t", masked);
        Assert.DoesNotContain("abc", masked);
        Assert.Contains("\"apiKey\":\"***\"", masked);
        Assert.Contains("\"n\":1", masked);

        var form = "user=bob&password=hunter2&remember=true";
        Assert.Equal("user=bob&password=***&remember=true", rules.Format(Encoding.UTF8.GetBytes(form), form.Length, "application/x-www-form-urlencoded"));
        Assert.Equal("***", rules.HeaderValue("authorization", "Bearer xyz"));
        Assert.Equal("fr-FR", rules.HeaderValue("Accept-Language", "fr-FR"));
    }

    [Fact]
    public void Long_bodies_are_truncated()
    {
        var rules = new HttpCaptureRules(new HttpCaptureOptions { MaxBodyBytes = 10 });
        var text = rules.Format("0123456789"u8, 5000, "text/plain");
        Assert.StartsWith("0123456789", text);
        Assert.Contains("tronqué", text);
    }

    [Fact]
    public void Field_names_containing_a_sensitive_word_are_masked()
    {
        var rules = new HttpCaptureRules(new HttpCaptureOptions());
        // Noms réels : le nom exact « password » ne les reconnaissait pas.
        var json = """
            {"accountNewPassword":"a1","sftpPassword":"a2","RADIUS_PASSWORD":"a3","SIP_MD5SECRET":"a4","secretKey":"a5",
             "motDePasse":"a6","mdp_utilisateur":"a7","partnerApiKey":"a8","AUTHENTICATION_TOKEN":"a9",
             "cmdPortList":"visible-1","login":"visible-2","nbLignes":3}
            """;
        var masked = rules.Format(Encoding.UTF8.GetBytes(json), json.Length, "application/json");
        for (var i = 1; i <= 9; i++) Assert.DoesNotContain($"\"a{i}\"", masked);
        Assert.Contains("\"cmdPortList\":\"visible-1\"", masked); // contient « mdp » en lettres, pas en mot
        Assert.Contains("\"login\":\"visible-2\"", masked);
        Assert.Contains("\"nbLignes\":3", masked);

        var form = "_handler=login&Model.UserLogin=jdupont&Model.UserPassword=hunter2&__RequestVerificationToken=CfDJ8";
        Assert.Equal("_handler=login&Model.UserLogin=jdupont&Model.UserPassword=***&__RequestVerificationToken=***",
            rules.Format(Encoding.UTF8.GetBytes(form), form.Length, "application/x-www-form-urlencoded"));
        Assert.Equal("email=j%40exemple.fr&resetToken=***", rules.Query("?email=j%40exemple.fr&resetToken=abc"));
    }

    [Fact]
    public void Sensitive_fields_inside_objects_and_arrays_are_masked()
    {
        var rules = new HttpCaptureRules(new HttpCaptureOptions());
        var json = """{"credentials":{"user":"alice","userPassword":"s3cr3t"},"items":[{"id":1,"sipSecret":"x9"}]}""";
        var masked = rules.Format(Encoding.UTF8.GetBytes(json), json.Length, "application/json");
        Assert.Contains("\"user\":\"alice\"", masked);
        Assert.DoesNotContain("s3cr3t", masked);
        Assert.DoesNotContain("x9", masked);
        Assert.Contains("\"id\":1", masked);
    }

    [Fact]
    public void Configured_words_match_every_spelling()
    {
        var options = new HttpCaptureOptions();
        options.RedactedWords.Add("numero secu");
        var rules = new HttpCaptureRules(options);
        Assert.True(rules.IsRedacted("numeroSecu"));
        Assert.True(rules.IsRedacted("NUMERO_SECU"));
        Assert.True(rules.IsRedacted("patient.numeroSecu"));
        Assert.False(rules.IsRedacted("numero"));
    }

    [Fact]
    public void Header_names_containing_a_sensitive_word_are_masked()
    {
        var rules = new HttpCaptureRules(new HttpCaptureOptions());
        Assert.Equal("***", rules.HeaderValue("X-Partner-Token", "abc"));
        Assert.Equal("***", rules.HeaderValue("X-Api-Key", "abc"));
        Assert.Equal("gzip", rules.HeaderValue("Accept-Encoding", "gzip"));
    }

    [Theory]
    [InlineData("accountNewPassword", "account new password")]
    [InlineData("RADIUS_PASSWORD", "radius password")]
    [InlineData("Model.UserPassword", "model user password")]
    [InlineData("SIP_MD5SECRET", "sip md 5 secret")]
    [InlineData("XMLHttpRequest", "xml http request")]
    [InlineData("__RequestVerificationToken", "request verification token")]
    public void Names_are_split_into_words(string name, string expected) =>
        Assert.Equal(expected, string.Join(" ", HttpCaptureRules.Words(name)));
}
