package com.crossroads.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

import org.junit.Test;

public class ByteRangeTest {

    private static ByteRange parse(String header, long total) throws ByteRange.UnsatisfiableException {
        return ByteRange.parse(header, total);
    }

    @Test
    public void absentHeaderIsNull() throws Exception {
        assertNull(parse(null, 100));
    }

    @Test
    public void closedRange() throws Exception {
        ByteRange r = parse("bytes=10-19", 100);
        assertEquals(10, r.start);
        assertEquals(19, r.end);
        assertEquals(10, r.length());
        assertEquals("bytes 10-19/100", r.contentRange(100));
    }

    @Test
    public void openEndedRangeRunsToEnd() throws Exception {
        ByteRange r = parse("bytes=90-", 100);
        assertEquals(90, r.start);
        assertEquals(99, r.end);
    }

    @Test
    public void endIsClampedToResource() throws Exception {
        ByteRange r = parse("bytes=0-5000", 100);
        assertEquals(0, r.start);
        assertEquals(99, r.end);
    }

    @Test
    public void suffixRange() throws Exception {
        ByteRange r = parse("bytes=-10", 100);
        assertEquals(90, r.start);
        assertEquals(99, r.end);
    }

    @Test
    public void suffixLongerThanResourceIsWholeResource() throws Exception {
        ByteRange r = parse("bytes=-500", 100);
        assertEquals(0, r.start);
        assertEquals(99, r.end);
    }

    @Test
    public void toleratesWhitespace() throws Exception {
        ByteRange r = parse(" bytes = 5 - 7 ", 100);
        assertEquals(5, r.start);
        assertEquals(7, r.end);
    }

    @Test
    public void startPastEndIsUnsatisfiable() {
        try {
            parse("bytes=100-", 100);
            fail("expected UnsatisfiableException");
        } catch (ByteRange.UnsatisfiableException expected) {
            // ok
        }
    }

    @Test
    public void zeroSuffixIsUnsatisfiable() {
        try {
            parse("bytes=-0", 100);
            fail("expected UnsatisfiableException");
        } catch (ByteRange.UnsatisfiableException expected) {
            // ok
        }
    }

    @Test
    public void emptyResourceIsUnsatisfiable() {
        try {
            parse("bytes=0-", 0);
            fail("expected UnsatisfiableException");
        } catch (ByteRange.UnsatisfiableException expected) {
            // ok
        }
    }

    @Test
    public void malformedHeadersAreIgnored() throws Exception {
        assertNull(parse("bytes=", 100));
        assertNull(parse("bytes=-", 100));
        assertNull(parse("bytes=abc-10", 100));
        assertNull(parse("items=0-10", 100));
        assertNull(parse("bytes=0-10,20-30", 100));   // multi-range is not supported
        assertNull(parse("bytes=20-10", 100));        // last < first
        assertNull(parse("bytes=99999999999999999999-", 100)); // overflow
    }

    @Test
    public void boundedStreamStopsAtLimit() throws IOException {
        byte[] data = "0123456789".getBytes("US-ASCII");
        BoundedInputStream in = new BoundedInputStream(new ByteArrayInputStream(data), 4);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[3];
        int n;
        while ((n = in.read(buf, 0, buf.length)) != -1) out.write(buf, 0, n);
        assertArrayEquals("0123".getBytes("US-ASCII"), out.toByteArray());
        assertEquals(-1, in.read());
    }

    @Test
    public void boundedStreamSingleByteReads() throws IOException {
        byte[] data = { 1, 2, 3 };
        BoundedInputStream in = new BoundedInputStream(new ByteArrayInputStream(data), 2);
        assertEquals(1, in.read());
        assertEquals(2, in.read());
        assertEquals(-1, in.read());
    }

    @Test
    public void mimeTypesByExtension() {
        assertEquals("audio/flac", RangeAwareWebViewClient.mimeTypeFor("song.FLAC"));
        assertEquals("audio/mpeg", RangeAwareWebViewClient.mimeTypeFor("song.mp3"));
        assertEquals("audio/mp4", RangeAwareWebViewClient.mimeTypeFor("song.m4a"));
        assertEquals("audio/ogg", RangeAwareWebViewClient.mimeTypeFor("song.opus"));
        assertEquals("application/octet-stream", RangeAwareWebViewClient.mimeTypeFor("noext"));
    }
}
