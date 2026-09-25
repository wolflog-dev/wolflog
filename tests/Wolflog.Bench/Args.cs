sealed record Args(string Url, string? Key, string? Password, int Seconds, int Concurrency, int Batch)
{
    public static Args Parse(string[] a)
    {
        string Get(string name, string fallback)
        {
            var i = Array.IndexOf(a, "--" + name);
            return i >= 0 && i + 1 < a.Length ? a[i + 1] : fallback;
        }
        var key = Get("key", "");
        var password = Get("password", "");
        return new Args(Get("url", "http://localhost:5080").TrimEnd('/') + "/", key == "" ? null : key, password == "" ? null : password,
            int.Parse(Get("seconds", "20")), int.Parse(Get("concurrency", "8")), int.Parse(Get("batch", "1000")));
    }
}
