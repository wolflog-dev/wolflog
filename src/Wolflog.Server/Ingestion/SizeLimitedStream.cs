namespace Wolflog.Server.Ingestion;

/// <summary>
/// Lecture plafonnée d'un flux reçu, compté après décompression : protège la mémoire contre une « bombe de
/// décompression » (quelques Mo gzip ou brotli qui en donnent plusieurs Go). La lecture s'arrête dès que le plafond
/// est dépassé, sans rien allouer de plus.
/// </summary>
public sealed class SizeLimitedStream(Stream inner, long maxBytes) : Stream
{
    private long _read;

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => _read; set => throw new NotSupportedException(); }

    public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, Clamp(count)));

    public override int Read(Span<byte> buffer) => Count(inner.Read(buffer[..Clamp(buffer.Length)]));

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        Count(await inner.ReadAsync(buffer.AsMemory(offset, Clamp(count)), ct));

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
        Count(await inner.ReadAsync(buffer[..Clamp(buffer.Length)], ct));

    // Un octet de plus que le plafond est demandé : l'atteindre signale un contenu trop gros (et non pile à la limite).
    private int Clamp(int count) => (int)Math.Min(count, Math.Max(1, maxBytes + 1 - _read));

    private int Count(int n)
    {
        _read += n;
        if (_read > maxBytes) throw new PayloadTooLargeException(maxBytes);
        return n;
    }

    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
}
