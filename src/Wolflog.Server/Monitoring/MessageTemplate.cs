using System.Net;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Modèle de message des notifications, écrit dans l'éditeur de l'interface : Markdown réduit
/// (**gras**, _italique_, [texte](url), lignes « - » en liste), variables {{nom}} et mentions @[Nom](identifiant).
/// Rendu adapté à chaque canal : blocs Teams, mrkdwn Slack, HTML (e-mail), texte brut.
/// Une ligne dont toutes les variables sont vides disparaît (ex. « Consigne : {{consigne}} » sans consigne).
/// </summary>
public sealed class MessageTemplate
{
    public const string DefaultTitle = "{{statut}} : {{regle}}";
    public const string DefaultBody = "{{message}}\n_Consigne : {{consigne}}_\n{{date}}";
    public const int MaxLength = 4000;

    private abstract record Node;
    private sealed record Text(string Value) : Node;
    private sealed record Var(string Name) : Node;
    private sealed record Bold(List<Node> Children) : Node;
    private sealed record Italic(List<Node> Children) : Node;
    private sealed record Link(List<Node> Children, List<Node> Url) : Node;
    private sealed record Mention(string Name, string Id) : Node;
    private sealed record Line(bool Item, List<Node> Nodes);

    /// <summary>Syntaxe de sortie d'un canal.</summary>
    private sealed record Syntax(
        Func<string, string> Escape, Func<string, string> Bold, Func<string, string> Italic,
        Func<string, string, string> Link, Func<string, string, string> Mention);

    private readonly List<Line> _lines;

    private MessageTemplate(List<Line> lines) => _lines = lines;

    public static MessageTemplate Parse(string? template)
    {
        var lines = new List<Line>();
        foreach (var raw in (template ?? "").Replace("\r", "").Split('\n'))
        {
            var item = raw.StartsWith("- ", StringComparison.Ordinal) || raw.StartsWith("• ", StringComparison.Ordinal);
            lines.Add(new Line(item, ParseInline(item ? raw[2..] : raw)));
        }
        return new MessageTemplate(lines);
    }

    /// <summary>Noms des variables utilisées (pour ne calculer que les données coûteuses réellement demandées).</summary>
    public static bool Uses(string? template, string variable) =>
        template is not null && template.Contains("{{" + variable, StringComparison.OrdinalIgnoreCase);

    // ------------------------------------------------------------------ rendus

    public string Plain(IReadOnlyDictionary<string, string?> vars) =>
        string.Join("\n", Visible(vars).Select(l => (l.Item ? "• " : "") + Inline(l.Nodes, vars, PlainSyntax)));

    /// <summary>Une seule ligne (titre, objet d'e-mail).</summary>
    public string SingleLine(IReadOnlyDictionary<string, string?> vars) =>
        string.Join(" ", Visible(vars).Select(l => Inline(l.Nodes, vars, PlainSyntax).Trim()).Where(s => s.Length > 0));

    public string Slack(IReadOnlyDictionary<string, string?> vars) =>
        string.Join("\n", Visible(vars).Select(l => (l.Item ? "• " : "") + Inline(l.Nodes, vars, SlackSyntax)));

    public string Html(IReadOnlyDictionary<string, string?> vars)
    {
        var sb = new StringBuilder();
        var inList = false;
        foreach (var l in Visible(vars))
        {
            if (l.Item != inList)
            {
                sb.Append(l.Item ? "<ul style=\"margin:0 0 8px;padding-left:20px\">" : "</ul>");
                inList = l.Item;
            }
            var html = Inline(l.Nodes, vars, HtmlSyntax);
            if (l.Item) sb.Append("<li>").Append(html).Append("</li>");
            else if (string.IsNullOrWhiteSpace(html)) sb.Append("<div style=\"height:8px\"></div>");
            else sb.Append("<p style=\"margin:0 0 6px\">").Append(html).Append("</p>");
        }
        if (inList) sb.Append("</ul>");
        return sb.ToString();
    }

    /// <summary>Blocs TextBlock d'une Adaptive Card et entités de mention Teams.</summary>
    public (List<object> Blocks, List<object> Mentions) Teams(IReadOnlyDictionary<string, string?> vars)
    {
        var mentions = new List<object>();
        var syntax = TeamsSyntax with
        {
            Mention = (name, id) =>
            {
                mentions.Add(new { type = "mention", text = $"<at>{name}</at>", mentioned = new { id, name } });
                return $"<at>{name}</at>";
            },
        };
        var blocks = new List<object>();
        var list = new List<string>();
        var gap = false;
        void FlushList()
        {
            if (list.Count == 0) return;
            blocks.Add(new { type = "TextBlock", text = string.Join("\r", list), wrap = true, spacing = gap ? "Medium" : "Small" });
            list.Clear();
            gap = false;
        }
        foreach (var l in Visible(vars))
        {
            var text = Inline(l.Nodes, vars, syntax);
            if (l.Item) { list.Add("- " + text); continue; }
            FlushList();
            if (string.IsNullOrWhiteSpace(text)) { gap = true; continue; }
            blocks.Add(new { type = "TextBlock", text, wrap = true, spacing = gap ? "Medium" : "Small" });
            gap = false;
        }
        FlushList();
        return (blocks, mentions);
    }

    // ------------------------------------------------------------------ syntaxes

    private static readonly Syntax PlainSyntax = new(s => s, s => s, s => s,
        (text, url) => string.IsNullOrEmpty(url) || text == url ? text : $"{text} ({url})", (name, _) => "@" + name);

    private static readonly Syntax TeamsSyntax = new(s => s, s => $"**{s}**", s => $"_{s}_",
        (text, url) => string.IsNullOrEmpty(url) ? text : $"[{text}]({url})", (name, _) => "@" + name);

    private static readonly Syntax SlackSyntax = new(
        s => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;"),
        s => $"*{s}*", s => $"_{s}_",
        (text, url) => string.IsNullOrEmpty(url) ? text : $"<{url}|{text}>",
        (name, id) => id switch
        {
            "here" or "channel" or "everyone" => $"<!{id}>",
            _ when id.Length > 1 && id[0] is 'U' or 'W' && id.All(char.IsLetterOrDigit) => $"<@{id}>",
            _ when id.Length > 1 && id[0] == 'S' && id.All(char.IsLetterOrDigit) => $"<!subteam^{id}>",
            _ => "@" + name,
        });

    private static readonly Syntax HtmlSyntax = new(WebUtility.HtmlEncode, s => $"<strong>{s}</strong>", s => $"<em>{s}</em>",
        (text, url) => string.IsNullOrEmpty(url) ? text : $"<a href=\"{WebUtility.HtmlEncode(url)}\">{text}</a>",
        (name, _) => $"<strong>@{WebUtility.HtmlEncode(name)}</strong>");

    // ------------------------------------------------------------------ rendu commun

    /// <summary>Lignes affichées : sans celles dont toutes les variables sont vides, sans vides en double ni en bordure.</summary>
    private IEnumerable<Line> Visible(IReadOnlyDictionary<string, string?> vars)
    {
        var kept = new List<Line>();
        foreach (var l in _lines)
        {
            var names = new List<string>();
            Collect(l.Nodes, names);
            if (names.Count > 0 && names.All(n => string.IsNullOrWhiteSpace(Value(vars, n)))) continue;
            var blank = l.Nodes.Count == 0 || l.Nodes.All(n => n is Text t && string.IsNullOrWhiteSpace(t.Value));
            if (blank && !l.Item && (kept.Count == 0 || IsBlank(kept[^1]))) continue;
            kept.Add(l);
        }
        while (kept.Count > 0 && IsBlank(kept[^1])) kept.RemoveAt(kept.Count - 1);
        return kept;

        static bool IsBlank(Line l) => !l.Item && l.Nodes.All(n => n is Text t && string.IsNullOrWhiteSpace(t.Value));
    }

    private static void Collect(List<Node> nodes, List<string> names)
    {
        foreach (var n in nodes)
            switch (n)
            {
                case Var v: names.Add(v.Name); break;
                case Bold b: Collect(b.Children, names); break;
                case Italic i: Collect(i.Children, names); break;
                case Link k: Collect(k.Children, names); Collect(k.Url, names); break;
            }
    }

    private static string? Value(IReadOnlyDictionary<string, string?> vars, string name) =>
        vars.TryGetValue(name, out var v) ? v : null;

    private static string Inline(List<Node> nodes, IReadOnlyDictionary<string, string?> vars, Syntax syntax)
    {
        var sb = new StringBuilder();
        foreach (var n in nodes)
        {
            sb.Append(n switch
            {
                Text t => syntax.Escape(t.Value),
                Var v => syntax.Escape(Value(vars, v.Name) ?? ""),
                Bold b => Wrap(b.Children, syntax.Bold),
                Italic i => Wrap(i.Children, syntax.Italic),
                Link k => LinkText(k),
                Mention m => syntax.Mention(m.Name, m.Id),
                _ => "",
            });
        }
        return sb.ToString();

        string Wrap(List<Node> children, Func<string, string> style)
        {
            var inner = Inline(children, vars, syntax);
            // Pas de « ** ** » autour d'une variable vide : rendu propre dans tous les canaux.
            return string.IsNullOrWhiteSpace(inner) ? inner : style(inner);
        }

        string LinkText(Link k)
        {
            var url = Inline(k.Url, vars, PlainSyntax).Trim();
            var text = Inline(k.Children, vars, syntax);
            if (string.IsNullOrWhiteSpace(text)) text = syntax.Escape(url);
            // Seuls les liens web sont conservés (pas de javascript: dans un e-mail).
            return url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)
                ? syntax.Link(text, url)
                : text;
        }
    }

    // ------------------------------------------------------------------ analyse

    private static List<Node> ParseInline(string s)
    {
        var nodes = new List<Node>();
        var text = new StringBuilder();
        var i = 0;
        while (i < s.Length)
        {
            if (s[i] == '\\' && i + 1 < s.Length)
            {
                text.Append(s[i + 1]);
                i += 2;
                continue;
            }
            if (At(s, i, "{{"))
            {
                var end = s.IndexOf("}}", i + 2, StringComparison.Ordinal);
                var name = end > 0 ? s[(i + 2)..end].Trim() : "";
                if (name.Length > 0 && name.All(c => char.IsLetterOrDigit(c) || c is '_' or '.'))
                {
                    Flush();
                    nodes.Add(new Var(name.ToLowerInvariant()));
                    i = end + 2;
                    continue;
                }
            }
            if (At(s, i, "**"))
            {
                var end = s.IndexOf("**", i + 2, StringComparison.Ordinal);
                if (end > i + 2)
                {
                    Flush();
                    nodes.Add(new Bold(ParseInline(s[(i + 2)..end])));
                    i = end + 2;
                    continue;
                }
            }
            if (s[i] == '_' && (i == 0 || !char.IsLetterOrDigit(s[i - 1])))
            {
                var end = ItalicEnd(s, i + 1);
                if (end > i + 1)
                {
                    Flush();
                    nodes.Add(new Italic(ParseInline(s[(i + 1)..end])));
                    i = end + 1;
                    continue;
                }
            }
            if (At(s, i, "@[") && TryBrackets(s, i + 1, out var name2, out var id, out var next) && id.Length > 0)
            {
                Flush();
                nodes.Add(new Mention(name2.Trim(), id.Trim()));
                i = next;
                continue;
            }
            if (s[i] == '[' && TryBrackets(s, i, out var label, out var url, out next))
            {
                Flush();
                nodes.Add(new Link(ParseInline(label), ParseInline(url.Trim())));
                i = next;
                continue;
            }
            text.Append(s[i]);
            i++;
        }
        Flush();
        return nodes;

        void Flush()
        {
            if (text.Length == 0) return;
            nodes.Add(new Text(text.ToString()));
            text.Clear();
        }
    }

    private static bool At(string s, int i, string token) => string.CompareOrdinal(s, i, token, 0, token.Length) == 0;

    /// <summary>« _ » fermant : suivi d'une fin de ligne ou d'un caractère qui n'est ni lettre ni chiffre.</summary>
    private static int ItalicEnd(string s, int from)
    {
        for (var j = from; j < s.Length; j++)
        {
            if (At(s, j, "{{"))
            {
                var close = s.IndexOf("}}", j, StringComparison.Ordinal);
                if (close > 0) { j = close + 1; continue; }
            }
            if (s[j] == '_' && (j + 1 == s.Length || !char.IsLetterOrDigit(s[j + 1]))) return j;
        }
        return -1;
    }

    /// <summary>[texte](cible) à partir du crochet ouvrant.</summary>
    private static bool TryBrackets(string s, int open, out string label, out string target, out int next)
    {
        label = target = "";
        next = open;
        var close = s.IndexOf(']', open + 1);
        if (close < 0 || close + 1 >= s.Length || s[close + 1] != '(') return false;
        // Parenthèses équilibrées : une URL peut en contenir.
        var depth = 0;
        var end = -1;
        for (var j = close + 2; j < s.Length && end < 0; j++)
        {
            if (s[j] == '(') depth++;
            else if (s[j] == ')' && depth-- == 0) end = j;
        }
        if (end < 0) return false;
        label = s[(open + 1)..close];
        target = s[(close + 2)..end];
        next = end + 1;
        return true;
    }
}
