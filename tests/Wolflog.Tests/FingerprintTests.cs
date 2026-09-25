namespace Wolflog.Tests;

public class FingerprintTests
{
    private const string Stack1 = """
        System.InvalidOperationException: Client introuvable (id=12)
           at Shop.Orders.OrderService.Load(Int32 id) in C:\src\Shop\OrderService.cs:line 42
           at Shop.Orders.OrderService.<GetAsync>b__12_0() in C:\src\Shop\OrderService.cs:line 30
           at Shop.Api.Program.<Main>b__0_1(Int32 id)
        """;

    private const string Stack2 = """
        System.InvalidOperationException: Client introuvable (id=99)
           at Shop.Orders.OrderService.Load(Int32 id) in /app/src/Shop/OrderService.cs:line 44
           at Shop.Orders.OrderService.<GetAsync>b__13_0() in /app/src/Shop/OrderService.cs:line 31
           at Shop.Api.Program.<Main>b__0_1(Int32 id)
        """;

    [Fact]
    public void Same_problem_same_fingerprint_despite_lines_ids_and_paths()
    {
        var a = Fingerprint.Compute("System.InvalidOperationException", "Client introuvable (id=12)", Stack1);
        var b = Fingerprint.Compute("System.InvalidOperationException", "Client introuvable (id=99)", Stack2);
        Assert.Equal(a, b);
        Assert.Equal(16, a.Length);
    }

    [Fact]
    public void Framework_frames_do_not_split_groups()
    {
        // Cas réel : la frame EndpointMiddleware n'apparaît pas toujours (inlining du JIT).
        const string a = """
            System.InvalidOperationException: Client introuvable (id=31)
               at Program.<>c.<<Main>$>b__0_5(ILogger`1 log) in C:\Demo\Program.cs:line 51
               at lambda_method4(Closure, Object, HttpContext)
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        const string b = """
            System.InvalidOperationException: Client introuvable (id=7)
               at Program.<>c.<<Main>$>b__0_5(ILogger`1 log) in C:\Demo\Program.cs:line 51
               at lambda_method4(Closure, Object, HttpContext)
               at Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke(HttpContext httpContext)
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        Assert.Equal(
            Fingerprint.Compute("System.InvalidOperationException", null, a),
            Fingerprint.Compute("System.InvalidOperationException", null, b));
    }

    [Fact]
    public void Wolflog_capture_middleware_frame_is_ignored()
    {
        const string withCapture = """
            System.InvalidOperationException: x
               at Program.<>c.<<Main>$>b__0_6(ILogger`1 log) in C:\Demo\Program.cs:line 62
               at Microsoft.AspNetCore.Routing.EndpointRoutingMiddleware.Invoke(HttpContext httpContext)
               at Wolflog.Client.Internal.HttpCaptureStartupFilter.Capture(HttpContext ctx, RequestDelegate next) in C:\Wolflog\HttpCapture.cs:line 116
            """;
        const string without = """
            System.InvalidOperationException: y
               at Program.<>c.<<Main>$>b__0_6(ILogger`1 log) in C:\Demo\Program.cs:line 62
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        Assert.Equal(
            Fingerprint.Compute("System.InvalidOperationException", null, withCapture),
            Fingerprint.Compute("System.InvalidOperationException", null, without));
    }

    [Fact]
    public void Different_type_different_fingerprint()
    {
        var a = Fingerprint.Compute("System.InvalidOperationException", null, Stack1);
        var b = Fingerprint.Compute("System.ArgumentException", null, Stack1);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Without_stack_message_is_normalized()
    {
        var a = Fingerprint.Compute("TimeoutException", "Timeout after 30 s on 'db-1' (id 3f2504e0-4f89-11d3-9a0c-0305e82c3301)", null);
        var b = Fingerprint.Compute("TimeoutException", "Timeout after 45 s on 'db-2' (id 7c9e6679-7425-40de-944b-e07fc1f90ae7)", null);
        Assert.Equal(a, b);
    }
}
