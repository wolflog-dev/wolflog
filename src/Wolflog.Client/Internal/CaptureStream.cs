namespace Wolflog.Client.Internal;

/// <summary>Flux de réponse qui transmet tout et garde une copie des premiers octets.</summary>
internal sealed class CaptureStream(Stream inner, int limit) : Stream
{
    private readonly byte[] _buffer = new byte[limit];
    private int _captured;

    public long Total { get; private set; }
    public ReadOnlySpan<byte> Captured => _buffer.AsSpan(0, _captured);

    private void Keep(ReadOnlySpan<byte> data)
    {
        Total += data.Length;
        var room = _buffer.Length - _captured;
        if (room <= 0) return;
        var n = Math.Min(room, data.Length);
        data[..n].CopyTo(_buffer.AsSpan(_captured));
        _captured += n;
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        Keep(buffer.AsSpan(offset, count));
        inner.Write(buffer, offset, count);
    }

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        Keep(buffer);
        inner.Write(buffer);
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        Keep(buffer.AsSpan(offset, count));
        return inner.WriteAsync(buffer, offset, count, ct);
    }

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        Keep(buffer.Span);
        return inner.WriteAsync(buffer, ct);
    }

    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => Total; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}
