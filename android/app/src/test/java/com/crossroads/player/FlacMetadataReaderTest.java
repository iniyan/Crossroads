package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class FlacMetadataReaderTest {

    /** STREAMINFO body: rate/channels/bits/samples packed into the 8 bytes at offset 10, md5 at 18. */
    static byte[] streamInfo(int sampleRate, int channels, int bits, long totalSamples, int md5Fill) {
        long packed = ((long) sampleRate << 44) | ((long) (channels - 1) << 41) | ((long) (bits - 1) << 36) | totalSamples;
        return TestBytes.builder()
            .u16be(4096).u16be(4096)      // block sizes
            .u24be(0).u24be(0)            // frame sizes
            .u64be(packed)
            .fill(16, md5Fill)
            .build();
    }

    static byte[] block(int type, byte[] body, boolean last) {
        return TestBytes.builder().u8((last ? 0x80 : 0) | type).u24be(body.length).bytes(body).build();
    }

    static byte[] vorbisComment(String vendor, String... comments) {
        TestBytes b = TestBytes.builder();
        byte[] v = vendor.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        b.u32le(v.length).bytes(v).u32le(comments.length);
        for (String c : comments) {
            byte[] cb = c.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            b.u32le(cb.length).bytes(cb);
        }
        return b.build();
    }

    static InputStream stream(byte[]... parts) {
        TestBytes b = TestBytes.builder();
        for (byte[] p : parts) b.bytes(p);
        return new ByteArrayInputStream(b.build());
    }

    private static final byte[] FLAC = "fLaC".getBytes();

    @Test
    public void readsStreamInfoTagsAndPicturePresence() throws IOException {
        byte[] file = TestBytes.builder()
            .bytes(FLAC)
            .bytes(block(0, streamInfo(96000, 2, 24, 27_312_000L, 0xAB), false))
            .bytes(block(4, vorbisComment("reference libFLAC",
                "TITLE=Airbag", "artist=Radiohead", "PERFORMER=Violin: A", "PERFORMER=Cello: B",
                "MUSICBRAINZ_TRACKID=a1b2", "LYRICS=[00:01.00]line", "=novalue", "NOEQUALS",
                "METADATA_BLOCK_PICTURE=AAAA"), false))
            .bytes(block(6, TestBytes.builder().fill(5000, 7).build(), false))  // picture, skipped
            .bytes(block(1, new byte[100], true))                              // padding, last
            .ascii("audio frames...")
            .build();

        FlacMetadataReader.Result r = FlacMetadataReader.read(new ByteArrayInputStream(file));
        assertEquals(96000, r.sampleRate);
        assertEquals(2, r.channels);
        assertEquals(24, r.bitsPerSample);
        assertEquals(27_312_000L, r.totalSamples);
        assertEquals("abababababababababababababababab", r.md5);
        assertTrue(r.hasPicture);
        assertEquals(4, r.blocks);
        assertEquals("reference libFLAC", r.vendor);
        assertEquals(Arrays.asList("Airbag"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Radiohead"), r.tags.get("ARTIST"));
        assertEquals(Arrays.asList("Violin: A", "Cello: B"), r.tags.get("PERFORMER"));
        assertEquals(Arrays.asList("a1b2"), r.tags.get("MUSICBRAINZ_TRACKID"));
        assertEquals(Arrays.asList("[00:01.00]line"), r.tags.get("LYRICS"));
        assertFalse(r.tags.containsKey("METADATA_BLOCK_PICTURE"));
        assertFalse(r.tags.containsKey(""));
        assertFalse(r.tags.containsKey("NOEQUALS"));
    }

    @Test
    public void zeroMd5IsNull() throws IOException {
        byte[] file = TestBytes.builder().bytes(FLAC).bytes(block(0, streamInfo(44100, 1, 16, 10, 0), true)).build();
        FlacMetadataReader.Result r = FlacMetadataReader.read(new ByteArrayInputStream(file));
        assertNull(r.md5);
        assertEquals(1, r.channels);
        assertEquals(16, r.bitsPerSample);
        assertFalse(r.hasPicture);
        assertTrue(r.tags.isEmpty());
    }

    @Test
    public void decodesEdgeValues() {
        FlacMetadataReader.Result r = new FlacMetadataReader.Result();
        FlacMetadataReader.parseStreamInfo(streamInfo(192000, 8, 32, (1L << 36) - 1, 1), r);
        assertEquals(192000, r.sampleRate);
        assertEquals(8, r.channels);
        assertEquals(32, r.bitsPerSample);
        assertEquals((1L << 36) - 1, r.totalSamples);
    }

    @Test
    public void skipsLeadingId3Tag() throws IOException {
        byte[] id3 = TestBytes.builder().ascii("ID3").bytes(4, 0, 0).syncsafe(300).fill(300, 1).build();
        byte[] file = TestBytes.builder().bytes(id3).bytes(FLAC).bytes(block(0, streamInfo(48000, 2, 16, 5, 1), true)).build();
        FlacMetadataReader.Result r = FlacMetadataReader.read(new ByteArrayInputStream(file));
        assertEquals(48000, r.sampleRate);
    }

    @Test
    public void rejectsNonFlacAndTruncatedInput() throws IOException {
        assertNull(FlacMetadataReader.read(new ByteArrayInputStream("RIFF....WAVE".getBytes())));
        assertNull(FlacMetadataReader.read(new ByteArrayInputStream("fL".getBytes())));
        assertNull(FlacMetadataReader.read(new ByteArrayInputStream(new byte[0])));
        // Header claims a block but the data is cut: no STREAMINFO -> null, no exception escapes as data.
        byte[] cut = TestBytes.builder().bytes(FLAC).u8(0x04).u24be(50).ascii("short").build();
        try {
            FlacMetadataReader.read(new ByteArrayInputStream(cut));
        } catch (IOException expected) {
            // EOF while reading a declared block is reported as IOException.
        }
    }

    @Test
    public void handlesMultiValueAndNonAsciiTags() throws IOException {
        byte[] file = TestBytes.builder()
            .bytes(FLAC)
            .bytes(block(0, streamInfo(44100, 2, 16, 1, 1), false))
            .bytes(block(4, vorbisComment("v", "ARTIST=Björk", "ARTIST=Guest", "TRACKNUMBER=07", "TRACKTOTAL=12"), true))
            .build();
        FlacMetadataReader.Result r = FlacMetadataReader.read(new ByteArrayInputStream(file));
        List<String> artists = r.tags.get("ARTIST");
        assertEquals(Arrays.asList("Björk", "Guest"), artists);
        assertEquals(Arrays.asList("07"), r.tags.get("TRACKNUMBER"));
    }

    @Test
    public void streamWithoutSeekSupportStillWorks() throws IOException {
        byte[] file = TestBytes.builder()
            .bytes(FLAC)
            .bytes(block(0, streamInfo(44100, 2, 16, 1, 1), false))
            .bytes(block(6, new byte[70000], true))
            .build();
        InputStream noSkip = new ByteArrayInputStream(file) {
            @Override
            public long skip(long n) { return 0; } // force the read-through path
        };
        FlacMetadataReader.Result r = FlacMetadataReader.read(noSkip);
        assertTrue(r.hasPicture);
        assertEquals(44100, r.sampleRate);
    }
}
