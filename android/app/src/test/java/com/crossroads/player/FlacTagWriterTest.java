package com.crossroads.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** Synthetic-file tests of the Java FLAC tag writer (the ffmpeg-based cases live in the shared vectors). */
public class FlacTagWriterTest {

    private static final byte[] FLAC = "fLaC".getBytes();

    static byte[] streamInfo() {
        return FlacMetadataReaderTest.streamInfo(44100, 2, 16, 12345L, 0xAB);
    }

    static byte[] block(int type, byte[] body, boolean last) {
        return FlacMetadataReaderTest.block(type, body, last);
    }

    static byte[] vc(String vendor, String... comments) {
        return FlacMetadataReaderTest.vorbisComment(vendor, comments);
    }

    static final byte[] AUDIO = "ÿøaudio frames here audio frames here".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);

    /** STREAMINFO + VORBIS_COMMENT(+ extras) + optional PADDING + fake audio. */
    static byte[] file(String vendor, String[] comments, int padding, byte[]... extras) {
        TestBytes b = TestBytes.builder().bytes(FLAC);
        boolean vcLast = padding < 0 && extras.length == 0;
        b.bytes(block(0, streamInfo(), false));
        b.bytes(block(4, vc(vendor, comments), vcLast));
        for (int i = 0; i < extras.length; i++) {
            b.bytes(extras[i]);
        }
        if (padding >= 0) b.bytes(block(1, new byte[padding], true));
        return b.bytes(AUDIO).build();
    }

    static List<int[]> blocks(byte[] buf) {
        java.util.ArrayList<int[]> out = new java.util.ArrayList<>();
        int pos = FlacTagWriter.id3v2Length(buf) + 4;
        while (true) {
            int type = buf[pos] & 0x7F;
            int len = Bytes.u24be(buf, pos + 1);
            out.add(new int[] { type, len, pos + 4 });
            boolean last = (buf[pos] & 0x80) != 0;
            pos += 4 + len;
            if (last) break;
        }
        return out;
    }

    static byte[] audioOf(byte[] buf) throws IOException {
        return Arrays.copyOfRange(buf, FlacTagWriter.parseMetadata(buf).audioOffset, buf.length);
    }

    static int[] types(byte[] buf) {
        List<int[]> b = blocks(buf);
        int[] t = new int[b.size()];
        for (int i = 0; i < t.length; i++) t[i] = b.get(i)[0];
        return t;
    }

    @Test
    public void inPlaceWhenTheNewBlockFitsInPadding() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=Song", "ARTIST=Someone" }, 200);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops().set("ALBUM", "Some Album");
        byte[] out = FlacTagWriter.apply(original, ops, 8192);
        assertEquals(original.length, out.length);
        assertArrayEquals(new int[] { 0, 4, 1 }, types(out));
        assertEquals(200 - (4 + "ALBUM=Some Album".length()), blocks(out).get(2)[1]);
        assertArrayEquals(audioOf(original), audioOf(out));
        Map<String, List<String>> tags = FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), null);
        assertEquals(Arrays.asList("Some Album"), tags.get("ALBUM"));
        assertEquals(Arrays.asList("Song"), tags.get("TITLE"));
    }

    @Test
    public void exactFitDropsThePaddingBlock() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=Song" }, 20);
        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("ALBUM", "abcdefghijklmn"), 8192);
        assertArrayEquals(new int[] { 0, 4 }, types(out));
        assertEquals(original.length, out.length);
    }

    @Test
    public void leftoverBelowFourBytesRewrites() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=Song" }, 20);
        byte[] head = Arrays.copyOfRange(original, 0, FlacTagWriter.parseMetadata(original).audioOffset);
        FlacTagWriter.Plan plan = FlacTagWriter.plan(head, new FlacTagWriter.Ops().set("ALBUM", "xxxxxxxxxxxx"), 777);
        assertFalse(plan.inPlace);
        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("ALBUM", "xxxxxxxxxxxx"), 777);
        List<int[]> b = blocks(out);
        assertEquals(1, b.get(b.size() - 1)[0]);
        assertEquals(777, b.get(b.size() - 1)[1]);
    }

    @Test
    public void preservesOtherBlocksOrderVendorAndMergesPadding() throws IOException {
        byte[] app = block(2, TestBytes.builder().ascii("CROS").fill(40, 7).build(), false);
        byte[] midPadding = block(1, new byte[50], false);
        byte[] picture = block(6, new byte[300], false);
        byte[] original = file("vendor XYZ", new String[] { "TITLE=Song" }, 30, app, midPadding, picture);
        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("TITLE", "New"), 8192);
        assertArrayEquals(new int[] { 0, 4, 2, 6, 1 }, types(out));
        assertEquals(original.length, out.length);
        int[] appBlock = blocks(out).get(2);
        assertArrayEquals(Arrays.copyOfRange(app, 4, app.length), Arrays.copyOfRange(out, appBlock[2], appBlock[2] + appBlock[1]));
        String[] vendor = new String[1];
        FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), vendor);
        assertEquals("vendor XYZ", vendor[0]);
        assertArrayEquals(audioOf(original), audioOf(out));
    }

    @Test
    public void createsVorbisCommentAfterStreamInfoWhenMissing() throws IOException {
        byte[] original = TestBytes.builder().bytes(FLAC)
            .bytes(block(0, streamInfo(), false))
            .bytes(block(6, new byte[100], false))
            .bytes(block(1, new byte[500], true))
            .bytes(AUDIO).build();
        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("TITLE", "Fresh"), 8192);
        assertArrayEquals(new int[] { 0, 4, 6, 1 }, types(out));
        String[] vendor = new String[1];
        Map<String, List<String>> tags = FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), vendor);
        assertEquals(FlacTagWriter.DEFAULT_VENDOR, vendor[0]);
        assertEquals(Collections.singletonMap("TITLE", Arrays.asList("Fresh")), tags);
    }

    @Test
    public void refusesAFileWithTwoVorbisCommentBlocks() throws IOException {
        byte[] second = block(4, vc("other", "TITLE=Dup"), false);
        byte[] original = file("first", new String[] { "ARTIST=A" }, 100, second);
        try {
            FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("GENRE", "G"), 8192);
            fail("expected refusal");
        } catch (FlacTagWriter.FlacTagException e) {
            assertEquals("MULTIPLE_COMMENT_BLOCKS", e.code);
            assertTrue(e.getMessage().contains("multiple comment blocks"));
        }
        // Reading still works (first block).
        assertEquals(Arrays.asList("A"), FlacTagWriter.readTags(original, null).get("ARTIST"));
    }

    @Test
    public void keepsEntriesWithoutAKeyVerbatimAfterTheEditableOnes() throws IOException {
        byte[] original = file("vend", new String[] { "TITLE=a", "noequals", "=novalue", "ARTIST=x", "title=b" }, 512);
        java.util.List<String[]> comments = new java.util.ArrayList<>();
        java.util.List<byte[]> raw = new java.util.ArrayList<>();
        int[] vcBlock = blocks(original).get(1);
        FlacTagWriter.parseVorbisComment(original, vcBlock[2], vcBlock[1], comments, raw);
        assertEquals(3, comments.size());
        assertEquals(2, raw.size());
        assertEquals("noequals", new String(raw.get(0), java.nio.charset.StandardCharsets.ISO_8859_1));
        assertEquals("=novalue", new String(raw.get(1), java.nio.charset.StandardCharsets.ISO_8859_1));

        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("artist", "y"), 8192);
        assertEquals(original.length, out.length);
        Map<String, List<String>> tags = FlacTagWriter.readTags(out, null);
        assertEquals(Arrays.asList("a", "b"), tags.get("TITLE"));
        assertEquals(Arrays.asList("y"), tags.get("ARTIST"));
        comments.clear();
        raw.clear();
        vcBlock = blocks(out).get(1);
        FlacTagWriter.parseVorbisComment(out, vcBlock[2], vcBlock[1], comments, raw);
        assertEquals("noequals", new String(raw.get(0), java.nio.charset.StandardCharsets.ISO_8859_1));
        assertEquals("=novalue", new String(raw.get(1), java.nio.charset.StandardCharsets.ISO_8859_1));
        assertEquals("TITLE", comments.get(0)[0]);
        assertEquals("TITLE", comments.get(1)[0]);
        assertEquals("ARTIST", comments.get(2)[0]);
        // A no-op on such a file is still a no-op.
        byte[] head = Arrays.copyOfRange(out, 0, FlacTagWriter.parseMetadata(out).audioOffset);
        assertTrue(FlacTagWriter.plan(head, new FlacTagWriter.Ops(), 8192).unchanged);
    }

    @Test
    public void editsExistingKeysByTrimmedUpperCasedSpellingEvenWhenIllegal() throws IOException {
        byte[] original = file("vend", new String[] { "TITLE =old", "WEIRD~KEY=1", "\u00DCBER=2", "\u00DCber=3", "ARTIST=x" }, 512);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops().set("WEIRD~KEY", "4").set(" title", "new").set(" composer ", "C").remove("\u00FCber");
        byte[] out = FlacTagWriter.apply(original, ops, 8192);
        Map<String, List<String>> tags = FlacTagWriter.readTags(out, null);
        assertEquals(Arrays.asList("TITLE", "WEIRD~KEY", "ARTIST", "COMPOSER"), new java.util.ArrayList<>(tags.keySet()));
        assertEquals(Arrays.asList("new"), tags.get("TITLE"));
        assertEquals(Arrays.asList("4"), tags.get("WEIRD~KEY"));
        int[] vcBlock = blocks(out).get(1);
        String rawText = new String(out, vcBlock[2], vcBlock[1], java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(rawText.contains("TITLE =new"));   // spelling of the existing key kept
        assertFalse(rawText.contains("BER="));
        // The same spellings are still rejected as NEW keys; clearing an absent illegal key is a no-op.
        try {
            FlacTagWriter.apply(out, new FlacTagWriter.Ops().set("\u00DCBER", "again"), 8192);
            fail("expected rejection");
        } catch (FlacTagWriter.FlacTagException e) {
            assertEquals("INVALID_TAG", e.code);
        }
        assertArrayEquals(out, FlacTagWriter.apply(out, new FlacTagWriter.Ops().set("\u00DCBER").remove("BAD=KEY"), 8192));
    }

    @Test
    public void blankMatchesTheJsTrimSetExactly() throws IOException {
        int[] blank = { 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
            0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF };
        for (int c : blank) assertTrue(Integer.toHexString(c), FlacTagWriter.isBlank(String.valueOf((char) c)));
        int[] notBlank = { 0x1C, 0x1D, 0x1E, 0x1F, 0x180E, 0x200B, 0x85, 'x' };
        for (int c : notBlank) assertFalse(Integer.toHexString(c), FlacTagWriter.isBlank(String.valueOf((char) c)));
        assertTrue(FlacTagWriter.isBlank(""));
        assertEquals("x", FlacTagWriter.jsTrim(" \u3000x\u2028 "));
        assertEquals("\u001Cx\u001F", FlacTagWriter.jsTrim("\u001Cx\u001F"));
        assertEquals("TITLE", FlacTagWriter.foldKey(" title\uFEFF"));

        byte[] original = file("v", new String[] { "TITLE=T", "GENRE=G" }, 1024);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops()
            .set("TITLE", "\u001C")
            .set("ARTIST", "\u00A0\u2003", "\u001F", " kept ")
            .set("GENRE", "\u3000", "\u2028\u2029", "\u000B\u000C");
        Map<String, List<String>> tags = FlacTagWriter.readTags(FlacTagWriter.apply(original, ops, 8192), null);
        assertEquals(Arrays.asList("\u001C"), tags.get("TITLE"));
        assertEquals(Arrays.asList("\u001F", " kept "), tags.get("ARTIST"));
        assertNull(tags.get("GENRE"));
    }

    @Test
    public void keepsAnId3v2PrefixVerbatim() throws IOException {
        byte[] body = file("v", new String[] { "TITLE=T" }, 100);
        byte[] original = TestBytes.builder().ascii("ID3").bytes(4, 0, 0).syncsafe(50).fill(50, 0x11).bytes(body).build();
        byte[] out = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("ALBUM", "P"), 8192);
        assertArrayEquals(Arrays.copyOfRange(original, 0, 64), Arrays.copyOfRange(out, 0, 64));
        assertEquals(60, FlacTagWriter.parseMetadata(out).prefixLength);
        byte[] head = FlacTagWriter.readHead(new ByteArrayInputStream(out));
        assertEquals(Arrays.asList("P"), FlacTagWriter.readTags(head, null).get("ALBUM"));
    }

    @Test
    public void unicodeMultiValueAndEqualsInValues() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=T" }, 1000);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops()
            .set("TITLE", "Jóga – Björk 東京 🎵")
            .set("PERFORMER", "Violin: Ånna", "Cello: Bö")
            .set("COMMENT", "a=b=c");
        byte[] out = FlacTagWriter.apply(original, ops, 8192);
        Map<String, List<String>> tags = FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), null);
        assertEquals(Arrays.asList("Jóga – Björk 東京 🎵"), tags.get("TITLE"));
        assertEquals(Arrays.asList("Violin: Ånna", "Cello: Bö"), tags.get("PERFORMER"));
        assertEquals(Arrays.asList("a=b=c"), tags.get("COMMENT"));
    }

    @Test
    public void keyOrderExistingFirstThenNewAlphabetically_andSpellingKept() throws IOException {
        byte[] original = file("v", new String[] { "title=T", "Artist=A" }, 500);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops().set("zzz", "z").set("ARTIST", "B").set("aaa", "a").remove("Title");
        byte[] out = FlacTagWriter.apply(original, ops, 8192);
        Map<String, List<String>> tags = FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), null);
        assertEquals(Arrays.asList("ARTIST", "AAA", "ZZZ"), new java.util.ArrayList<>(tags.keySet()));
        int[] vcBlock = blocks(out).get(1);
        String raw = new String(out, vcBlock[2], vcBlock[1], java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(raw.contains("Artist=B"));
        assertTrue(raw.contains("AAA=a"));
        assertFalse(raw.contains("title="));
    }

    @Test
    public void noopIsReportedUnchanged() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=Same" }, 10);
        byte[] head = Arrays.copyOfRange(original, 0, FlacTagWriter.parseMetadata(original).audioOffset);
        FlacTagWriter.Plan plan = FlacTagWriter.plan(head, new FlacTagWriter.Ops().set("title", "Same"), 8192);
        assertTrue(plan.unchanged);
        assertArrayEquals(Arrays.copyOfRange(original, 4, head.length), plan.metadata);
    }

    @Test
    public void rejectsInvalidKeysAndValues() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=T" }, 10);
        String[][] bad = { { "BAD=KEY", "x" }, { "Ünïcode", "x" }, { "", "x" }, { "  ", "x" }, { "TITLE", "a\0b" } };
        for (String[] kv : bad) {
            try {
                FlacTagWriter.apply(original, new FlacTagWriter.Ops().set(kv[0], kv[1]), 8192);
                fail("expected rejection of " + kv[0]);
            } catch (FlacTagWriter.FlacTagException e) {
                assertEquals("INVALID_TAG", e.code);
            }
        }
    }

    @Test
    public void rejectsNonFlacTruncatedAndStreamInfoLess() {
        expectCode("RIFF....WAVE".getBytes(), "NOT_FLAC");
        expectCode(Arrays.copyOfRange(file("v", new String[] { "TITLE=T" }, 10), 0, 20), "TRUNCATED");
        expectCode(TestBytes.builder().bytes(FLAC).bytes(0x81, 0, 0, 2, 0, 0).ascii("audio").build(), "CORRUPT");
    }

    private static void expectCode(byte[] data, String code) {
        try {
            FlacTagWriter.apply(data, new FlacTagWriter.Ops().set("TITLE", "x"), 8192);
            fail("expected " + code);
        } catch (FlacTagWriter.FlacTagException e) {
            assertEquals(code, e.code);
        }
    }

    @Test
    public void readHeadStopsAtTheAudioAndHashesTheRest() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=T" }, 10, block(6, new byte[70000], false));
        ByteArrayInputStream in = new ByteArrayInputStream(original);
        byte[] head = FlacTagWriter.readHead(in);
        int audioOffset = FlacTagWriter.parseMetadata(original).audioOffset;
        assertEquals(audioOffset, head.length);
        assertArrayEquals(Arrays.copyOfRange(original, 0, audioOffset), head);
        // The rest of the stream is exactly the audio.
        String rest = FlacTagWriter.sha256Hex(in);
        String expected = FlacTagWriter.sha256Hex(new ByteArrayInputStream(audioOf(original)));
        assertEquals(expected, rest);
    }

    @Test
    public void verifyDetectsChangedStreamInfoAudioAndTags() throws IOException {
        byte[] original = file("v", new String[] { "TITLE=T" }, 100);
        FlacTagWriter.Ops ops = new FlacTagWriter.Ops().set("ALBUM", "A");
        byte[] head = Arrays.copyOfRange(original, 0, FlacTagWriter.parseMetadata(original).audioOffset);
        FlacTagWriter.Plan plan = FlacTagWriter.plan(head, ops, 8192);
        byte[] out = FlacTagWriter.apply(original, ops, 8192);
        String hash = FlacTagWriter.sha256Hex(new ByteArrayInputStream(audioOf(original)));
        assertNull(FlacTagWriter.verify(out, plan, hash));

        byte[] badAudio = out.clone();
        badAudio[badAudio.length - 1] ^= 1;
        assertEquals("audio data changed", FlacTagWriter.verify(badAudio, plan, hash));

        byte[] badSi = out.clone();
        badSi[8 + 20] ^= 1;
        assertEquals("STREAMINFO changed", FlacTagWriter.verify(badSi, plan, hash));

        byte[] otherTags = FlacTagWriter.apply(original, new FlacTagWriter.Ops().set("ALBUM", "B"), 8192);
        assertNotNull(FlacTagWriter.verify(otherTags, plan, hash));

        assertNotNull(FlacTagWriter.verify("nope".getBytes(), plan, hash));
    }
}
