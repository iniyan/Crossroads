package com.crossroads.player;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A single satisfiable HTTP byte range (inclusive bounds) resolved against a known
 * resource length. Pure Java so it can be unit-tested on the JVM.
 */
public final class ByteRange {

    /** Thrown when the range is syntactically fine but lies outside the resource (HTTP 416). */
    public static final class UnsatisfiableException extends Exception {
        UnsatisfiableException(String message) {
            super(message);
        }
    }

    private static final Pattern SINGLE_RANGE = Pattern.compile("^\\s*bytes\\s*=\\s*(\\d*)\\s*-\\s*(\\d*)\\s*$");

    public final long start;
    public final long end;
    /** True for a suffix range ({@code bytes=-N}), which carries no first-byte-pos. */
    public final boolean suffix;

    private ByteRange(long start, long end, boolean suffix) {
        this.start = start;
        this.end = end;
        this.suffix = suffix;
    }

    public long length() {
        return end - start + 1;
    }

    /**
     * Where the stream handed to the WebView must be positioned. Chromium's WebView loader
     * applies the request's first-byte-pos itself: it skips that many bytes of the stream an
     * intercepted response returns (android_webview InputStreamReader::Seek), so for an
     * explicit start the stream must begin at byte 0 or the body is served from twice the
     * offset. A suffix range has no first-byte-pos, so Chromium skips nothing and the stream
     * has to be positioned here.
     */
    public long streamPosition() {
        return suffix ? start : 0;
    }

    /** How many bytes of the stream (from {@link #streamPosition()}) the WebView may read. */
    public long streamLimit() {
        return suffix ? length() : end + 1;
    }

    public String contentRange(long total) {
        return String.format(Locale.ROOT, "bytes %d-%d/%d", start, end, total);
    }

    /**
     * Parses a {@code Range} request header.
     *
     * @return the range clamped to {@code total}, or {@code null} when the header is absent or
     *         not a single {@code bytes=} range we understand (the caller should then ignore the
     *         header and serve the whole resource, as RFC 9110 prescribes for invalid ranges).
     * @throws UnsatisfiableException when the range starts at or beyond the end of the resource
     *         (or the resource is empty), i.e. the response should be 416.
     */
    public static ByteRange parse(String header, long total) throws UnsatisfiableException {
        if (header == null) return null;
        Matcher m = SINGLE_RANGE.matcher(header);
        if (!m.matches()) return null;

        String first = m.group(1);
        String last = m.group(2);
        if (first.isEmpty() && last.isEmpty()) return null;

        try {
            if (first.isEmpty()) {
                // Suffix range: the last N bytes.
                long suffix = Long.parseLong(last);
                if (suffix == 0 || total <= 0) throw new UnsatisfiableException("empty suffix range");
                return new ByteRange(Math.max(0, total - suffix), total - 1, true);
            }

            long start = Long.parseLong(first);
            long end = last.isEmpty() ? Long.MAX_VALUE : Long.parseLong(last);
            if (end < start) return null; // invalid byte-range-spec: ignore the header
            if (start >= total) throw new UnsatisfiableException("range starts past end of resource");
            return new ByteRange(start, Math.min(end, total - 1), false);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
