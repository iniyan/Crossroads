package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Arrays;

import org.junit.Test;

public class Mp4AudioReaderTest {

    static byte[] atom(String type, byte[]... children) {
        TestBytes body = TestBytes.builder();
        for (byte[] c : children) body.bytes(c);
        byte[] b = body.build();
        return TestBytes.builder().u32be(8 + b.length).ascii(type).bytes(b).build();
    }

    static byte[] fullAtom(String type, byte[]... children) {
        TestBytes body = TestBytes.builder().u32be(0);
        for (byte[] c : children) body.bytes(c);
        byte[] b = body.build();
        return TestBytes.builder().u32be(8 + b.length).ascii(type).bytes(b).build();
    }

    static byte[] ftyp() {
        return atom("ftyp", TestBytes.builder().ascii("M4A ").u32be(0).ascii("M4A mp42isom").build());
    }

    static byte[] mdhd(long timescale, long duration) {
        return atom("mdhd", TestBytes.builder().u32be(0).u32be(0).u32be(0).u32be(timescale).u32be(duration).u16be(0).u16be(0).build());
    }

    static byte[] hdlr(String handler) {
        return atom("hdlr", TestBytes.builder().u32be(0).u32be(0).ascii(handler).zeros(12).u8(0).build());
    }

    /** AudioSampleEntry v0 with optional child atoms. */
    static byte[] sampleEntry(String fourcc, int channels, int sampleSize, int rate, byte[]... children) {
        TestBytes body = TestBytes.builder().zeros(6).u16be(1)
            .u16be(0).u16be(0).u32be(0)          // version, revision, vendor
            .u16be(channels).u16be(sampleSize).u16be(0).u16be(0)
            .u32be((long) rate << 16);
        for (byte[] c : children) body.bytes(c);
        byte[] b = body.build();
        return TestBytes.builder().u32be(8 + b.length).ascii(fourcc).bytes(b).build();
    }

    static byte[] stsd(byte[] entry) {
        return atom("stsd", TestBytes.builder().u32be(0).u32be(1).bytes(entry).build());
    }

    static byte[] esdsAac(long avgBitrate) {
        // ES_Descriptor(3) { ES_ID(2), flags(1), DecoderConfig(4) { objectType, streamType, bufferSize(3), maxBitrate(4), avgBitrate(4) } }
        byte[] decoderConfig = TestBytes.builder().u8(0x40).u8(0x15).u24be(0).u32be(avgBitrate).u32be(avgBitrate).build();
        byte[] es = TestBytes.builder().u16be(1).u8(0).u8(0x04).u8(decoderConfig.length).bytes(decoderConfig).build();
        byte[] esds = TestBytes.builder().u32be(0).u8(0x03).u8(es.length).bytes(es).build();
        return TestBytes.builder().u32be(8 + esds.length).ascii("esds").bytes(esds).build();
    }

    static byte[] alacCookie(int bitDepth, int channels, long avgBitrate, long sampleRate) {
        byte[] cookie = TestBytes.builder().u32be(0).u32be(4096).u8(0).u8(bitDepth).u8(40).u8(10).u8(14).u8(channels)
            .u16be(255).u32be(0).u32be(avgBitrate).u32be(sampleRate).build();
        return TestBytes.builder().u32be(8 + cookie.length).ascii("alac").bytes(cookie).build();
    }

    static byte[] ilstText(String name, String value) {
        byte[] data = TestBytes.builder().u32be(1).u32be(0).utf8(value).build();
        return atom(name, TestBytes.builder().u32be(8 + data.length).ascii("data").bytes(data).build());
    }

    static byte[] ilstFreeform(String description, String value) {
        byte[] mean = atom("mean", TestBytes.builder().u32be(0).ascii("com.apple.iTunes").build());
        byte[] nameAtom = atom("name", TestBytes.builder().u32be(0).utf8(description).build());
        byte[] data = TestBytes.builder().u32be(1).u32be(0).utf8(value).build();
        return atom("----", mean, nameAtom, TestBytes.builder().u32be(8 + data.length).ascii("data").bytes(data).build());
    }

    static byte[] ilstTrkn(int number, int total) {
        byte[] data = TestBytes.builder().u32be(0).u32be(0).u16be(0).u16be(number).u16be(total).u16be(0).build();
        return atom("trkn", TestBytes.builder().u32be(8 + data.length).ascii("data").bytes(data).build());
    }

    static byte[] ilstCover() {
        byte[] data = TestBytes.builder().u32be(13).u32be(0).fill(50, 0xEE).build();
        return atom("covr", TestBytes.builder().u32be(8 + data.length).ascii("data").bytes(data).build());
    }

    static byte[] file(byte[] moov) {
        return TestBytes.builder().bytes(ftyp()).bytes(moov).bytes(atom("mdat", new byte[64])).build();
    }

    private static byte[] audioTrak(long timescale, long duration, byte[] entry) {
        return atom("trak", atom("mdia", mdhd(timescale, duration), hdlr("soun"), atom("minf", atom("stbl", stsd(entry)))));
    }

    @Test
    public void readsAacTrackAndItunesTags() throws IOException {
        byte[] moov = atom("moov",
            audioTrak(44100, 44100 * 30, sampleEntry("mp4a", 2, 16, 44100, esdsAac(256000))),
            atom("udta", fullAtom("meta", atom("ilst",
                ilstText("©nam", "Song"),
                ilstText("aART", "Album Artist"),
                ilstText("©wrk", "Work"),
                ilstText("©lyr", "la la"),
                ilstTrkn(3, 12),
                ilstFreeform("MusicBrainz Track Id", "uuid-1"),
                ilstFreeform("CONDUCTOR", "C"),
                ilstCover()
            )))
        );
        Mp4AudioReader.Result r = Mp4AudioReader.read(new ByteArrayInputStream(file(moov)));
        assertEquals("AAC", r.codec);
        assertEquals(2, r.channels);
        assertEquals(44100, r.sampleRate);
        assertEquals(0, r.bitsPerSample);
        assertEquals(256000, r.bitrate);
        assertEquals(30.0, r.duration, 0.0001);
        assertEquals(44100L * 30, r.totalSamples);
        assertTrue(r.hasPicture);
        assertEquals(Arrays.asList("Song"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Album Artist"), r.tags.get("ALBUMARTIST"));
        assertEquals(Arrays.asList("Work"), r.tags.get("WORK"));
        assertEquals(Arrays.asList("la la"), r.tags.get("UNSYNCEDLYRICS"));
        assertEquals(Arrays.asList("3/12"), r.tags.get("TRACKNUMBER"));
        assertEquals(Arrays.asList("uuid-1"), r.tags.get("MUSICBRAINZ_TRACKID"));
        assertEquals(Arrays.asList("C"), r.tags.get("CONDUCTOR"));
    }

    @Test
    public void readsAlacCookie() throws IOException {
        byte[] moov = atom("moov", audioTrak(96000, 96000 * 10, sampleEntry("alac", 2, 16, 96000, alacCookie(24, 2, 1_500_000, 96000))));
        Mp4AudioReader.Result r = Mp4AudioReader.read(new ByteArrayInputStream(file(moov)));
        assertEquals("ALAC", r.codec);
        assertEquals(24, r.bitsPerSample);
        assertEquals(2, r.channels);
        assertEquals(96000, r.sampleRate);
        assertEquals(1_500_000, r.bitrate);
        assertEquals(96000L * 10, r.totalSamples);
    }

    @Test
    public void ignoresVideoTracksAndUsesFirstAudioTrack() throws IOException {
        byte[] video = atom("trak", atom("mdia", mdhd(600, 6000), hdlr("vide"), atom("minf", atom("stbl", stsd(sampleEntry("avc1", 0, 0, 0))))));
        byte[] moov = atom("moov", video, audioTrak(48000, 48000, sampleEntry("mp4a", 1, 16, 48000, esdsAac(64000))));
        Mp4AudioReader.Result r = Mp4AudioReader.read(new ByteArrayInputStream(file(moov)));
        assertEquals("AAC", r.codec);
        assertEquals(48000, r.sampleRate);
        assertEquals(1, r.channels);
    }

    @Test
    public void handlesMoovAfterMdatAndLargeSizeHeaders() throws IOException {
        byte[] moov = atom("moov", audioTrak(44100, 44100, sampleEntry("mp4a", 2, 16, 44100, esdsAac(128000))));
        byte[] mdatBody = new byte[100];
        byte[] mdat = TestBytes.builder().u32be(1).ascii("mdat").u64be(16 + mdatBody.length).bytes(mdatBody).build();
        byte[] data = TestBytes.builder().bytes(ftyp()).bytes(mdat).bytes(moov).build();
        Mp4AudioReader.Result r = Mp4AudioReader.read(new ByteArrayInputStream(data));
        assertEquals("AAC", r.codec);
        assertEquals(128000, r.bitrate);
    }

    @Test
    public void deeplyNestedWaveAtomsDoNotOverflowTheStack() throws IOException {
        // A sample entry whose 'wave' child nests 'wave' atoms thousands deep (each 8 bytes
        // of header). Unbounded recursion used to throw StackOverflowError out of the probe.
        int depth = 20_000;
        byte[] inner = alacCookie(24, 2, 1_000, 48000);
        byte[] nested = inner;
        for (int i = 0; i < depth; i++) {
            nested = TestBytes.builder().u32be(8 + nested.length).ascii("wave").bytes(nested).build();
        }
        byte[] moov = atom("moov", audioTrak(48000, 48000, sampleEntry("alac", 2, 16, 48000, nested)));
        Mp4AudioReader.Result r = Mp4AudioReader.read(new ByteArrayInputStream(file(moov)));
        assertEquals("ALAC", r.codec);
        assertEquals(48000, r.sampleRate);
        // The cookie sits below the depth limit and is (correctly) never reached.
        assertEquals(16, r.bitsPerSample);

        // A shallow 'wave' wrapper (what real QuickTime files write) is still descended into.
        byte[] shallow = TestBytes.builder().u32be(8 + inner.length).ascii("wave").bytes(inner).build();
        byte[] moov2 = atom("moov", audioTrak(48000, 48000, sampleEntry("alac", 2, 16, 48000, shallow)));
        Mp4AudioReader.Result r2 = Mp4AudioReader.read(new ByteArrayInputStream(file(moov2)));
        assertEquals(24, r2.bitsPerSample);
        assertEquals(1_000, r2.bitrate);
    }

    @Test
    public void moovLargerThanTheFileIsRejectedBeforeAllocation() throws IOException {
        // Header claims a 30 MB moov; the file is a few hundred bytes.
        byte[] data = TestBytes.builder().bytes(ftyp()).u32be(30L * 1024 * 1024).ascii("moov").zeros(64).build();
        assertNull(Mp4AudioReader.read(new ByteArrayInputStream(data), data.length));
    }

    @Test
    public void rejectsNonMp4() throws IOException {
        assertNull(Mp4AudioReader.read(new ByteArrayInputStream("fLaC....".getBytes())));
        assertNull(Mp4AudioReader.read(new ByteArrayInputStream(new byte[4])));
        assertNull(Mp4AudioReader.read(new ByteArrayInputStream(ftyp())));                    // no moov
        assertNull(Mp4AudioReader.read(new ByteArrayInputStream(file(atom("moov", atom("mvhd", new byte[100]))))));  // no audio track
    }

    @Test
    public void codecNames() {
        assertEquals("AAC", Mp4AudioReader.codecFor("mp4a"));
        assertEquals("ALAC", Mp4AudioReader.codecFor("alac"));
        assertEquals("FLAC", Mp4AudioReader.codecFor("fLaC"));
        assertEquals("PCM", Mp4AudioReader.codecFor("in24"));
        assertEquals("OPUS", Mp4AudioReader.codecFor("Opus"));
        assertEquals("XYZ", Mp4AudioReader.codecFor("xyz "));
    }
}
