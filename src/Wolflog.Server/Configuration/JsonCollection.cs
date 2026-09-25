using System.Text.Json;

namespace Wolflog.Server.Configuration;

public interface IEntity
{
    string Id { get; set; }
}

/// <summary>
/// Petite collection persistée dans un fichier JSON du dossier de données (écriture atomique).
/// Relue automatiquement si le fichier est modifié par ailleurs (commande <c>wolflog</c>, restauration…).
/// Adaptée aux données de configuration : quelques milliers d'éléments au plus.
/// </summary>
public class JsonCollection<T> where T : class, IEntity
{
    protected static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _path;
    private readonly Lock _lock = new();
    private List<T> _items = [];
    private DateTime _loadedStamp;

    public JsonCollection(string dataDirectory, string fileName)
    {
        Directory.CreateDirectory(dataDirectory);
        _path = Path.Combine(dataDirectory, fileName);
        Reload();
    }

    public string FilePath => _path;

    private void Reload()
    {
        if (!File.Exists(_path))
        {
            _items = [];
            _loadedStamp = DateTime.MinValue;
            return;
        }
        _items = JsonSerializer.Deserialize<List<T>>(File.ReadAllText(_path), Json) ?? [];
        _loadedStamp = File.GetLastWriteTimeUtc(_path);
    }

    private void RefreshIfChanged()
    {
        var stamp = File.Exists(_path) ? File.GetLastWriteTimeUtc(_path) : DateTime.MinValue;
        if (stamp != _loadedStamp) Reload();
    }

    public List<T> All()
    {
        lock (_lock)
        {
            RefreshIfChanged();
            return _items.Select(Clone).ToList();
        }
    }

    public T? Get(string id)
    {
        lock (_lock)
        {
            RefreshIfChanged();
            var item = _items.FirstOrDefault(i => i.Id == id);
            return item is null ? null : Clone(item);
        }
    }

    public T? Find(Func<T, bool> predicate)
    {
        lock (_lock)
        {
            RefreshIfChanged();
            var item = _items.FirstOrDefault(predicate);
            return item is null ? null : Clone(item);
        }
    }

    public T Upsert(T item)
    {
        if (string.IsNullOrEmpty(item.Id)) item.Id = NewId();
        lock (_lock)
        {
            RefreshIfChanged();
            var i = _items.FindIndex(x => x.Id == item.Id);
            if (i >= 0) _items[i] = Clone(item);
            else _items.Add(Clone(item));
            Save();
        }
        return item;
    }

    /// <summary>Modifie un élément sur place ; retourne la version enregistrée (null s'il n'existe pas).</summary>
    public T? Update(string id, Action<T> change)
    {
        lock (_lock)
        {
            RefreshIfChanged();
            var item = _items.FirstOrDefault(x => x.Id == id);
            if (item is null) return null;
            change(item);
            Save();
            return Clone(item);
        }
    }

    public bool Delete(string id)
    {
        lock (_lock)
        {
            RefreshIfChanged();
            var removed = _items.RemoveAll(x => x.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    /// <summary>Remplace tout le contenu (restauration, purge).</summary>
    public void ReplaceAll(IEnumerable<T> items)
    {
        lock (_lock)
        {
            _items = items.Select(Clone).ToList();
            Save();
        }
    }

    private void Save()
    {
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_items, Json));
        File.Move(tmp, _path, overwrite: true);
        _loadedStamp = File.GetLastWriteTimeUtc(_path);
    }

    private static T Clone(T item) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(item, Json), Json)!;

    public static string NewId() => Guid.NewGuid().ToString("N")[..12];
}
