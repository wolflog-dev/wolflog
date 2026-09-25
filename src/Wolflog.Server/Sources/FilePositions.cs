namespace Wolflog.Server.Sources;

/// <summary>Positions de lecture des fichiers, conservées entre deux démarrages.</summary>
public sealed class FilePositions
{
    private readonly string _path;
    private readonly ConcurrentDictionary<string, long> _positions;
    private bool _dirty;

    public FilePositions(string path)
    {
        _path = path;
        try
        {
            _positions = File.Exists(path)
                ? new(JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(path)) ?? [], StringComparer.OrdinalIgnoreCase)
                : new(StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            _positions = new(StringComparer.OrdinalIgnoreCase);
        }
    }

    public bool TryGet(string file, out long position) => _positions.TryGetValue(file, out position);

    public void Set(string file, long position)
    {
        _positions[file] = position;
        _dirty = true;
    }

    public void Save()
    {
        if (!_dirty) return;
        _dirty = false;
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_positions));
        File.Move(tmp, _path, overwrite: true);
    }
}
