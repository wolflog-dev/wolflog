namespace Wolflog.Tests;

public class SpanNameTests
{
    [Theory]
    [InlineData("/api/orders/341", "/api/orders/{id}")]
    [InlineData("/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/cart", "/users/{guid}/cart")]
    [InlineData("/blobs/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b?x=1", "/blobs/{hash}")]
    [InlineData("/api/v2/health", "/api/v2/health")]
    public void Client_paths_are_templated(string path, string expected) =>
        Assert.Equal(expected, OtlpConverter.TemplatePath(path));
}
