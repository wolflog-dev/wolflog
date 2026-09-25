using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Wolflog.Tests;

/// <summary>Conventions du code source : vérifiées à chaque exécution des tests (et donc en CI).</summary>
public partial class CodeConventionsTests
{
    // Déclaration de type de premier niveau : en début de ligne (espaces de noms "file-scoped"), hors types "file".
    [GeneratedRegex(@"^(?:(?:public|internal|sealed|static|abstract|partial|readonly|unsafe|ref)\s+)*(?:class|record|struct|interface|enum|delegate\s+[\w<>\[\],?. ]+?)\s+(?:struct\s+|class\s+)?(\w+)(?=\s*[<({:;]|\s*$|\s+(?:where|:))", RegexOptions.Multiline)]
    private static partial Regex TopLevelType();

    private static readonly string Root = FindRoot();

    // Chemin de ce fichier à la compilation : indépendant de l'endroit où les binaires sont produits.
    private static string FindRoot([CallerFilePath] string source = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(source)!);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Wolflog.slnx"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Racine du dépôt introuvable (Wolflog.slnx).");
    }

    private static IEnumerable<string> SourceFiles() =>
        new[] { "src", "tests", "samples" }
            .Select(d => Path.Combine(Root, d))
            .Where(Directory.Exists)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.cs", SearchOption.AllDirectories))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                     && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));

    [Fact]
    public void One_type_per_file()
    {
        var offenders = SourceFiles()
            .Select(f => (File: Path.GetRelativePath(Root, f), Types: TopLevelType().Matches(File.ReadAllText(f)).Select(m => m.Groups[1].Value).Distinct().ToList()))
            .Where(x => x.Types.Count > 1)
            .Select(x => $"{x.File} : {string.Join(", ", x.Types)}")
            .ToList();
        Assert.True(offenders.Count == 0, "Un seul type par fichier :\n" + string.Join("\n", offenders));
    }

    [Fact]
    public void Type_is_in_the_file_of_the_same_name()
    {
        var offenders = SourceFiles()
            .Select(f => (File: Path.GetRelativePath(Root, f), Stem: Path.GetFileNameWithoutExtension(f).Split('.')[0],
                          Types: TopLevelType().Matches(File.ReadAllText(f)).Select(m => m.Groups[1].Value).ToList()))
            .Where(x => x.Types.Count == 1 && x.Types[0] != x.Stem && x.Stem != "Program")
            .Select(x => $"{x.File} contient {x.Types[0]}")
            .ToList();
        Assert.True(offenders.Count == 0, "Le fichier doit porter le nom du type :\n" + string.Join("\n", offenders));
    }

    [Fact]
    public void File_scoped_namespaces()
    {
        var offenders = SourceFiles()
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"^namespace\s+[\w.]+\s*(\r?\n)?\s*\{", RegexOptions.Multiline))
            .Select(f => Path.GetRelativePath(Root, f))
            .ToList();
        Assert.True(offenders.Count == 0, "Espaces de noms \"file-scoped\" attendus :\n" + string.Join("\n", offenders));
    }
}
