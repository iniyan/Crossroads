package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import org.junit.Test;

public class Id3v2ReaderTest {

    /** ID3v2.3/2.4 frame with the given raw body. */
    static byte[] frame(int major, String id, byte[] body) {
        TestBytes b = TestBytes.builder().ascii(id);
        if (major == 4) b.syncsafe(body.length); else b.u32be(body.length);
        return b.u16be(0).bytes(body).build();
    }

    static byte[] frame(String id, byte[] body) {
        return frame(4, id, body);
    }

    /** Text frame, UTF-8 (encoding 3). */
    static byte[] textFrame(String id, String text) {
        return frame(id, TestBytes.builder().u8(3).utf8(text).build());
    }

    static byte[] frame22(String id, byte[] body) {
        return TestBytes.builder().ascii(id).u24be(body.length).bytes(body).build();
    }

    /** Whole tag with header (no unsync, no extended header). */
    static byte[] tag(int major, byte[]... frames) {
        return tag(major, 0, frames);
    }

    static byte[] tag(int major, int flags, byte[]... frames) {
        TestBytes body = TestBytes.builder();
        for (byte[] f : frames) body.bytes(f);
        body.zeros(16); // padding
        byte[] b = body.build();
        return TestBytes.builder().ascii("ID3").u8(major).u8(0).u8(flags).syncsafe(b.length).bytes(b).build();
    }

    @Test
    public void mapsCommonV24Frames() throws IOException {
        byte[] tag = tag(4,
            textFrame("TIT2", "Song"),
            textFrame("TPE1", "Artist"),
            textFrame("TPE2", "Album Artist"),
            textFrame("TPE3", "Conductor"),
            textFrame("TALB", "Album"),
            textFrame("TRCK", "5/10"),
            textFrame("TPOS", "1/2"),
            textFrame("TDRC", "2001-04-05"),
            textFrame("TCON", "(17)"),
            textFrame("TCOM", "Comp One\0Comp Two"),
            textFrame("TIPL", "producer\0P One\0engineer\0E"),
            textFrame("MVNM", "Allegro"),
            frame("TXXX", TestBytes.builder().u8(3).utf8("MusicBrainz Album Id").u8(0).utf8("1111-2222").build()),
            frame("TXXX", TestBytes.builder().u8(3).utf8("WORK").u8(0).utf8("Symphony No. 5").build()),
            frame("TXXX", TestBytes.builder().u8(3).utf8("replaygain_track_gain").u8(0).utf8("-6.5 dB").build()),
            frame("USLT", TestBytes.builder().u8(3).ascii("eng").u8(0).utf8("la la\nla").build()),
            frame("COMM", TestBytes.builder().u8(3).ascii("eng").utf8("desc").u8(0).utf8("a comment").build()),
            frame("UFID", TestBytes.builder().ascii("http://musicbrainz.org").u8(0).ascii("a1b2c3d4-e5f6-7890-abcd-ef1234567890").build()),
            frame("APIC", TestBytes.builder().u8(0).ascii("image/png").u8(0).u8(3).u8(0).fill(100, 9).build()),
            frame("POPM", TestBytes.builder().ascii("user@x").u8(0).u8(196).u32be(3).build()),
            frame("PRIV", TestBytes.builder().ascii("owner").u8(0).fill(10, 1).build())
        );
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag));
        assertEquals(4, r.major);
        assertEquals(tag.length, r.tagLength);
        assertTrue(r.hasPicture);
        assertEquals(Arrays.asList("Song"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Artist"), r.tags.get("ARTIST"));
        assertEquals(Arrays.asList("Album Artist"), r.tags.get("ALBUMARTIST"));
        assertEquals(Arrays.asList("Conductor"), r.tags.get("CONDUCTOR"));
        assertEquals(Arrays.asList("5/10"), r.tags.get("TRACKNUMBER"));
        assertEquals(Arrays.asList("1/2"), r.tags.get("DISCNUMBER"));
        assertEquals(Arrays.asList("2001-04-05"), r.tags.get("DATE"));
        assertEquals(Arrays.asList("Rock"), r.tags.get("GENRE"));
        assertEquals(Arrays.asList("Comp One", "Comp Two"), r.tags.get("COMPOSER"));
        assertEquals(Arrays.asList("producer: P One", "engineer: E"), r.tags.get("INVOLVEDPEOPLE"));
        assertEquals(Arrays.asList("Allegro"), r.tags.get("MOVEMENTNAME"));
        assertEquals(Arrays.asList("1111-2222"), r.tags.get("MUSICBRAINZ_ALBUMID"));
        assertEquals(Arrays.asList("Symphony No. 5"), r.tags.get("WORK"));
        assertEquals(Arrays.asList("-6.5 dB"), r.tags.get("REPLAYGAIN_TRACK_GAIN"));
        assertEquals(Arrays.asList("la la\nla"), r.tags.get("UNSYNCEDLYRICS"));
        assertEquals(Arrays.asList("a comment"), r.tags.get("COMMENT"));
        assertEquals(Arrays.asList("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), r.tags.get("MUSICBRAINZ_TRACKID"));
        assertEquals(Arrays.asList("196"), r.tags.get("RATING"));
        assertFalse(r.tags.containsKey("PRIV"));
        assertFalse(r.tags.containsKey("APIC"));
    }

    @Test
    public void decodesTextEncodings() throws IOException {
        byte[] latin = frame("TIT2", TestBytes.builder().u8(0).bytes("Café".getBytes(StandardCharsets.ISO_8859_1)).build());
        byte[] utf16bom = frame("TALB", TestBytes.builder().u8(1).bytes(0xFF, 0xFE).bytes("Björk".getBytes(StandardCharsets.UTF_16LE)).build());
        byte[] utf16be = frame("TPE1", TestBytes.builder().u8(2).bytes("Édith".getBytes(StandardCharsets.UTF_16BE)).build());
        byte[] utf16NoBom = frame("TCOM", TestBytes.builder().u8(1).bytes("Ravel".getBytes(StandardCharsets.UTF_16LE)).build());
        byte[] txxxWide = frame("TXXX", TestBytes.builder().u8(1).bytes(0xFF, 0xFE).bytes("Desc".getBytes(StandardCharsets.UTF_16LE)).bytes(0, 0)
            .bytes(0xFF, 0xFE).bytes("Val".getBytes(StandardCharsets.UTF_16LE)).build());
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag(4, latin, utf16bom, utf16be, utf16NoBom, txxxWide)));
        assertEquals(Arrays.asList("Café"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Björk"), r.tags.get("ALBUM"));
        assertEquals(Arrays.asList("Édith"), r.tags.get("ARTIST"));
        assertEquals(Arrays.asList("Ravel"), r.tags.get("COMPOSER"));
        assertEquals(Arrays.asList("Val"), r.tags.get("DESC"));
    }

    @Test
    public void readsV23WithGlobalUnsyncAndExtendedHeader() throws IOException {
        // Body with an FF byte that unsynchronisation turns into FF 00.
        byte[] body = frame(3, "TIT2", TestBytes.builder().u8(0).bytes(0x41, 0xFF, 0x42).build());
        byte[] ext = TestBytes.builder().u32be(6).u16be(0).u32be(0).build(); // v2.3 extended header, size 6
        TestBytes b = TestBytes.builder().bytes(ext);
        for (byte x : body) {
            b.u8(x);
            if ((x & 0xFF) == 0xFF) b.u8(0);
        }
        byte[] payload = b.build();
        byte[] tag = TestBytes.builder().ascii("ID3").u8(3).u8(0).u8(0x80 | 0x40).syncsafe(payload.length).bytes(payload).build();
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag));
        assertEquals(3, r.major);
        assertEquals(Arrays.asList("AÿB"), r.tags.get("TITLE"));
    }

    @Test
    public void readsV24PerFrameUnsyncAndDataLengthIndicator() throws IOException {
        byte[] raw = TestBytes.builder().u8(3).utf8("A").bytes(0xFF).utf8("B").build();
        byte[] unsynced = Id3v2Reader.deUnsync(raw, 0, raw.length); // sanity: deUnsync of plain data is identity
        assertEquals(raw.length, unsynced.length);
        // Build frame: flags 0x0003 (data length indicator + unsync), body = DLI(4) + unsynced bytes.
        TestBytes body = TestBytes.builder().syncsafe(raw.length);
        for (byte x : raw) { body.u8(x); if ((x & 0xFF) == 0xFF) body.u8(0); }
        byte[] fb = body.build();
        byte[] frame = TestBytes.builder().ascii("TIT2").syncsafe(fb.length).u16be(0x0003).bytes(fb).build();
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag(4, frame)));
        assertEquals(1, r.tags.get("TITLE").size());
        assertEquals("AÿB".length(), new String(raw, 1, raw.length - 1, StandardCharsets.ISO_8859_1).length());
    }

    @Test
    public void readsV22ThreeLetterFrames() throws IOException {
        byte[] tag = tag(2,
            frame22("TT2", TestBytes.builder().u8(0).ascii("Old Song").build()),
            frame22("TP1", TestBytes.builder().u8(0).ascii("Old Artist").build()),
            frame22("TRK", TestBytes.builder().u8(0).ascii("7").build()),
            frame22("ULT", TestBytes.builder().u8(0).ascii("eng").u8(0).ascii("lyrics").build()),
            frame22("PIC", TestBytes.builder().u8(0).ascii("PNG").u8(3).u8(0).fill(10, 1).build())
        );
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag));
        assertEquals(2, r.major);
        assertEquals(Arrays.asList("Old Song"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Old Artist"), r.tags.get("ARTIST"));
        assertEquals(Arrays.asList("7"), r.tags.get("TRACKNUMBER"));
        assertEquals(Arrays.asList("lyrics"), r.tags.get("UNSYNCEDLYRICS"));
        assertTrue(r.hasPicture);
    }

    @Test
    public void syncedLyricsBecomeLrcLines() throws IOException {
        byte[] sylt = frame("SYLT", TestBytes.builder()
            .u8(3).ascii("eng").u8(2).u8(1).utf8("desc").u8(0)
            .utf8("First line").u8(0).u32be(1500)
            .utf8("Second").u8(0).u32be(61230)
            .build());
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag(4, sylt)));
        assertEquals(Arrays.asList("[00:01.50]First line\n[01:01.23]Second"), r.tags.get("SYNCEDLYRICS"));
    }

    @Test
    public void absentOrBrokenTagsAreHandled() throws IOException {
        assertNull(Id3v2Reader.read(new ByteArrayInputStream("fLaC....".getBytes())));
        assertNull(Id3v2Reader.read(new ByteArrayInputStream(new byte[2])));
        // Unsupported major version
        assertNull(Id3v2Reader.read(new ByteArrayInputStream(TestBytes.builder().ascii("ID3").u8(9).u8(0).u8(0).syncsafe(0).build())));
        // Frame size overrunning the tag: stop cleanly with what was read so far.
        byte[] good = textFrame("TIT2", "ok");
        byte[] bad = TestBytes.builder().ascii("TALB").syncsafe(999999).u16be(0).build();
        Id3v2Reader.Result r = Id3v2Reader.read(new ByteArrayInputStream(tag(4, good, bad)));
        assertEquals(Arrays.asList("ok"), r.tags.get("TITLE"));
        assertFalse(r.tags.containsKey("ALBUM"));
    }

    @Test
    public void oversizedTagIsSkippedByItsSizeInsteadOfAbortingTheParse() throws IOException {
        // A 33 MB tag (over MAX_TAG_BYTES) followed by a marker where the audio would start.
        int size = Id3v2Reader.MAX_TAG_BYTES + 1024;
        byte[] header = TestBytes.builder().ascii("ID3").u8(4).u8(0).u8(0).syncsafe(size).build();
        byte[] marker = "AUDIO".getBytes(StandardCharsets.ISO_8859_1);
        byte[] file = new byte[header.length + size + marker.length];
        System.arraycopy(header, 0, file, 0, header.length);
        System.arraycopy(marker, 0, file, header.length + size, marker.length);

        ByteArrayInputStream in = new ByteArrayInputStream(file);
        Id3v2Reader.Result r = Id3v2Reader.read(in, file.length);
        assertTrue(r.skipped);
        assertEquals(10L + size, r.tagLength);
        assertTrue(r.tags.isEmpty());
        // The stream now sits right after the tag: the caller can go on looking for frames.
        assertEquals("AUDIO", new String(Bytes.readUpTo(in, 5), StandardCharsets.ISO_8859_1));

        // A tag larger than the file itself is skipped the same way (to end of stream).
        byte[] bogus = TestBytes.builder().ascii("ID3").u8(3).u8(0).u8(0).syncsafe(5_000_000).zeros(100).build();
        Id3v2Reader.Result b = Id3v2Reader.read(new ByteArrayInputStream(bogus), bogus.length);
        assertTrue(b.skipped);
        assertEquals(10L + 5_000_000, b.tagLength);
    }

    @Test
    public void genreDecoding() {
        assertEquals("Rock", Id3v2Reader.decodeGenre("17"));
        assertEquals("Rock", Id3v2Reader.decodeGenre("(17)"));
        assertEquals("Custom", Id3v2Reader.decodeGenre("(17)Custom"));
        assertEquals("Jazz", Id3v2Reader.decodeGenre("Jazz"));
        assertEquals("999", Id3v2Reader.decodeGenre("999"));
    }

    @Test
    public void canonicalDescriptions() {
        assertEquals("MUSICBRAINZ_ALBUMID", Id3v2Reader.canonicalDescription("MusicBrainz Album Id"));
        assertEquals("ACOUSTID_ID", Id3v2Reader.canonicalDescription("Acoustid Id"));
        assertEquals("MY_CUSTOM_TAG", Id3v2Reader.canonicalDescription("my custom tag"));
        assertEquals("REPLAYGAIN_TRACK_GAIN", Id3v2Reader.canonicalDescription("replaygain_track_gain"));
        assertNull(Id3v2Reader.canonicalDescription("  "));
    }
}
