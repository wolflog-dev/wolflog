using System.Globalization;
using System.Text.RegularExpressions;

namespace Vigil.Server.Sources;

/// <summary>Messages syslog RFC 5424 (« &lt;34&gt;1 2026-… host app … ») et RFC 3164 (« &lt;34&gt;Sep 25 10:00:00 host app[12]: … »).</summary>
public static partial class SyslogParser
{
    [GeneratedRegex(@"^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[[^\]]*\])+) ?(.*)$", RegexOptions.Singleline)]
    private static partial Regex Rfc5424();

    [GeneratedRegex(@"^<(\d{1,3})>([A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}) (\S+) ([^:\[\s]+)(?:\[(\d+)\])?: ?(.*)$", RegexOptions.Singleline)]
    private static partial Regex Rfc3164();

    [GeneratedRegex(@"^<(\d{1,3})>(.*)$", RegexOptions.Singleline)]
    private static partial Regex PriOnly();

    public static readonly string[] Facilities =
        ["kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp", "ntp", "audit", "alert", "clock",
         "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7"];

    /// <summary>Gravité syslog (0 urgence … 7 debug) vers sévérité OpenTelemetry.</summary>
    public static int Severity(int syslogSeverity) => syslogSeverity switch
    {
        <= 2 => 21,
        3 => 17,
        4 => 13,
        5 or 6 => 9,
        _ => 5,
    };

    public static ParsedEntry Parse(string message, string? remoteHost)
    {
        message = message.TrimEnd('\n', '\r', '\0');
        var e = new ParsedEntry { Host = remoteHost };
        var m = Rfc5424().Match(message);
        if (m.Success)
        {
            ApplyPri(e, m.Groups[1].Value);
            if (DateTime.TryParse(m.Groups[2].Value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var t))
                e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
            e.Host = Nil(m.Groups[3].Value) ?? remoteHost;
            e.Service = Nil(m.Groups[4].Value);
            if (Nil(m.Groups[5].Value) is { } pid) e.Attributes["process.pid"] = pid;
            if (Nil(m.Groups[6].Value) is { } msgId) e.Attributes["syslog.msgid"] = msgId;
            if (m.Groups[7].Value != "-") e.Attributes["syslog.structured_data"] = m.Groups[7].Value;
            e.Body = m.Groups[8].Value.TrimStart('﻿');
            return e;
        }
        m = Rfc3164().Match(message);
        if (m.Success)
        {
            ApplyPri(e, m.Groups[1].Value);
            // L'année est absente en RFC 3164 : celle d'aujourd'hui, heure locale de l'émetteur supposée égale à celle du serveur.
            if (DateTime.TryParseExact($"{DateTime.Now.Year} {m.Groups[2].Value.Replace("  ", " ")}", "yyyy MMM d HH:mm:ss",
                    CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal | DateTimeStyles.AdjustToUniversal, out var t))
                e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
            e.Host = m.Groups[3].Value;
            e.Service = m.Groups[4].Value;
            if (m.Groups[5].Success) e.Attributes["process.pid"] = m.Groups[5].Value;
            e.Body = m.Groups[6].Value;
            return e;
        }
        m = PriOnly().Match(message);
        if (m.Success)
        {
            ApplyPri(e, m.Groups[1].Value);
            e.Body = m.Groups[2].Value;
        }
        else e.Body = message;
        return e;
    }

    private static void ApplyPri(ParsedEntry e, string pri)
    {
        if (!int.TryParse(pri, out var p)) return;
        e.Severity = Severity(p % 8);
        var facility = p / 8;
        if (facility < Facilities.Length) e.Category = Facilities[facility];
    }

    private static string? Nil(string v) => v == "-" ? null : v;
}
