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
}
