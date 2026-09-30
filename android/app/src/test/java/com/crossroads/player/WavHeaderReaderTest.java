package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Arrays;

import org.junit.Test;

public class WavHeaderReaderTest {

    static byte[] chunk(String id, byte[] body) {
        TestBytes b = TestBytes.builder().ascii(id).u32le(body.length).bytes(body);
        if ((body.length & 1) != 0) b.u8(0);
        return b.build();
    }

    static byte[] fmtPcm(int channels, int rate, int bits) {
        int blockAlign = channels * bits / 8;
        return TestBytes.builder().u16le(1).u16le(channels).u32le(rate).u32le((long) rate * blockAlign).u16le(blockAlign).u16le(bits).build();
    }

    static byte[] fmtExtensible(int channels, int rate, int containerBits, int validBits, int subFormat) {
        int blockAlign = channels * containerBits / 8;
        return TestBytes.builder()
            .u16le(0xFFFE).u16le(channels).u32le(rate).u32le((long) rate * blockAlign).u16le(blockAlign).u16le(containerBits)
            .u16le(22).u16le(validBits).u32le(0x3)
            .u16le(subFormat).bytes(0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
            .build();
    }

    static byte[] info(String... pairs) {
        TestBytes b = TestBytes.builder().ascii("INFO");
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            byte[] value = (pairs[i + 1] + "\0").getBytes();
            b.ascii(pairs[i]).u32le(value.length).bytes(value);
            if ((value.length & 1) != 0) b.u8(0);
        }
        return b.build();
    }

    static byte[] wav(byte[]... chunks) {
        TestBytes body = TestBytes.builder().ascii("WAVE");
        for (byte[] c : chunks) body.bytes(c);
        byte[] b = body.build();
        return TestBytes.builder().ascii("RIFF").u32le(b.length).bytes(b).build();
    }

    @Test
    public void readsPcmFormatDataSizeAndInfoTags() throws IOException {
        byte[] file = wav(
            chunk("fmt ", fmtPcm(2, 44100, 16)),
            chunk("LIST", info("INAM", "Wav Track", "IART", "Wav Artist", "IPRD", "Album", "ITRK", "3", "IXYZ", "custom")),
            chunk("data", new byte[4 * 1000]),
            chunk("junk", new byte[7])
        );
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(file));
        assertEquals(1, r.formatTag);
        assertEquals(2, r.channels);
        assertEquals(44100, r.sampleRate);
        assertEquals(16, r.bitsPerSample);
        assertEquals(4, r.blockAlign);
        assertEquals(4000, r.dataBytes);
        assertEquals(1000, r.totalSamples);
        assertFalse(r.isFloat);
        assertEquals(Arrays.asList("Wav Track"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("Wav Artist"), r.tags.get("ARTIST"));
        assertEquals(Arrays.asList("Album"), r.tags.get("ALBUM"));
        assertEquals(Arrays.asList("3"), r.tags.get("TRACKNUMBER"));
        assertEquals(Arrays.asList("custom"), r.tags.get("IXYZ"));
    }

    @Test
    public void infoChunkAfterDataIsStillRead() throws IOException {
        byte[] file = wav(chunk("fmt ", fmtPcm(1, 48000, 24)), chunk("data", new byte[3 * 10]), chunk("LIST", info("IGNR", "Jazz")));
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(file));
        assertEquals(10, r.totalSamples);
        assertEquals(Arrays.asList("Jazz"), r.tags.get("GENRE"));
    }

    @Test
    public void resolvesExtensibleFormat() throws IOException {
        byte[] file = wav(chunk("fmt ", fmtExtensible(2, 192000, 32, 24, 1)), chunk("data", new byte[8 * 5]));
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(file));
        assertEquals(1, r.formatTag);
        assertEquals(24, r.bitsPerSample);
        assertEquals(192000, r.sampleRate);
        assertEquals(5, r.totalSamples);

        byte[] floatFile = wav(chunk("fmt ", fmtExtensible(2, 96000, 32, 32, 3)), chunk("data", new byte[0]));
        WavHeaderReader.Result f = WavHeaderReader.read(new ByteArrayInputStream(floatFile));
        assertTrue(f.isFloat);
        assertEquals(0, f.totalSamples);
    }

    @Test
    public void readsEmbeddedId3Chunk() throws IOException {
        byte[] id3 = Id3v2ReaderTest.tag(4, Id3v2ReaderTest.textFrame("TIT2", "From ID3"), Id3v2ReaderTest.textFrame("TPE2", "AA"));
        byte[] file = wav(chunk("fmt ", fmtPcm(2, 44100, 16)), chunk("data", new byte[4]), chunk("id3 ", id3));
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(file));
        assertEquals(Arrays.asList("From ID3"), r.tags.get("TITLE"));
        assertEquals(Arrays.asList("AA"), r.tags.get("ALBUMARTIST"));
    }

    @Test
    public void rf64UsesDs64Sizes() throws IOException {
        byte[] ds64 = TestBytes.builder().u64le(5_000_000_000L).u64le(4_000_000_000L).u64le(1_000_000_000L).u32le(0).build();
        TestBytes body = TestBytes.builder().ascii("WAVE").bytes(chunk("ds64", ds64)).bytes(chunk("fmt ", fmtPcm(2, 44100, 16)))
            .ascii("data").u32le(0xFFFFFFFFL);
        byte[] file = TestBytes.builder().ascii("RF64").u32le(0xFFFFFFFFL).bytes(body.build()).build();
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(file));
        assertEquals(4_000_000_000L, r.dataBytes);
        assertEquals(1_000_000_000L, r.totalSamples);
    }

    /** RIFF/WAVE with a data chunk whose declared size is `declared` but whose real payload is `actual` bytes. */
    private static byte[] wavWithDataSize(long declared, byte[] actual, byte[]... trailing) {
        TestBytes body = TestBytes.builder().ascii("WAVE").bytes(chunk("fmt ", fmtPcm(2, 44100, 16)))
            .ascii("data").u32le(declared).bytes(actual);
        for (byte[] t : trailing) body.bytes(t);
        byte[] b = body.build();
        return TestBytes.builder().ascii("RIFF").u32le(b.length).bytes(b).build();
    }

    @Test
    public void bogusDataSizesAreClampedToTheFileLength() throws IOException {
        byte[] audio = new byte[4 * 250]; // 250 stereo 16-bit frames

        // 0xFFFFFFFF: streaming writer that never finalised the header.
        byte[] unfinished = wavWithDataSize(0xFFFFFFFFL, audio);
        WavHeaderReader.Result r = WavHeaderReader.read(new ByteArrayInputStream(unfinished), unfinished.length);
        assertEquals(audio.length, r.dataBytes);
        assertEquals(250, r.totalSamples);

        // 0: same, other convention.
        byte[] zero = wavWithDataSize(0, audio);
        r = WavHeaderReader.read(new ByteArrayInputStream(zero), zero.length);
        assertEquals(250, r.totalSamples);

        // Larger than the file: truncated download.
        byte[] truncated = wavWithDataSize(4L * 1_000_000, audio);
        r = WavHeaderReader.read(new ByteArrayInputStream(truncated), truncated.length);
        assertEquals(250, r.totalSamples);

        // A correct size is left alone, and chunks after the data are still found.
        byte[] fine = wavWithDataSize(audio.length, audio, chunk("LIST", info("IGNR", "Jazz")));
        r = WavHeaderReader.read(new ByteArrayInputStream(fine), fine.length);
        assertEquals(250, r.totalSamples);
        assertEquals(Arrays.asList("Jazz"), r.tags.get("GENRE"));

        // Without a known file length nothing can be clamped, but the reader must not throw.
        r = WavHeaderReader.read(new ByteArrayInputStream(zero));
        assertEquals(0, r.totalSamples);
    }

    @Test
    public void rejectsNonWavAndMissingFmt() throws IOException {
        assertNull(WavHeaderReader.read(new ByteArrayInputStream("fLaC".getBytes())));
        assertNull(WavHeaderReader.read(new ByteArrayInputStream(TestBytes.builder().ascii("RIFF").u32le(4).ascii("AVI ").build())));
        assertNull(WavHeaderReader.read(new ByteArrayInputStream(wav(chunk("data", new byte[4])))));
        assertNull(WavHeaderReader.read(new ByteArrayInputStream(new byte[3])));
    }
}
