package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;

/** Exposes at most {@code limit} bytes of the wrapped stream, then reports end-of-stream. */
public final class BoundedInputStream extends InputStream {

    private final InputStream in;
    private long remaining;

    public BoundedInputStream(InputStream in, long limit) {
        this.in = in;
        this.remaining = Math.max(0, limit);
    }

    @Override
    public int read() throws IOException {
        if (remaining <= 0) return -1;
        int b = in.read();
        if (b >= 0) remaining--;
        return b;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (remaining <= 0) return -1;
        int n = in.read(buffer, offset, (int) Math.min(length, remaining));
        if (n > 0) remaining -= n;
        return n;
    }

    @Override
    public long skip(long n) throws IOException {
        long skipped = in.skip(Math.min(n, remaining));
        remaining -= skipped;
        return skipped;
    }

    @Override
    public int available() throws IOException {
        return (int) Math.min(in.available(), remaining);
    }

    @Override
    public void close() throws IOException {
        in.close();
    }
}
