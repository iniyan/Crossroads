package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;

import org.junit.Test;

public class Mp3HeaderReaderTest {

    /** MPEG-1 Layer III, 44.1 kHz, 320 kbps (bitrate index 14), joint stereo, no padding: FF FB E0 60 (frame = 1044 bytes). */
    private static final int[] V1_L3_320_44100 = {0xFF, 0xFB, 0xE0, 0x60};
    /** MPEG-1 Layer III, 44.1 kHz, 128 kbps, mono: FF FB 90 C0 (frame = 417 bytes). */
    private static final int[] V1_L3_128_MONO = {0xFF, 0xFB, 0x90, 0xC0};
    /** MPEG-2 Layer III, 22.05 kHz, 64 kbps, stereo: FF F3 80 00 (frame = 208 bytes). */
    private static final int[] V2_L3_64_22050 = {0xFF, 0xF3, 0x80, 0x00};

    private static byte[] frames(int[] header, int frameLength, int count) {
        TestBytes b = TestBytes.builder();
        for (int i = 0; i < count; i++) {
            b.bytes(header).zeros(frameLength - 4);
        }
        return b.build();
    }

    @Test
    public void parsesCbrFrameHeader() throws IOException {
        byte[] data = frames(V1_L3_320_44100, 1044, 3);
        Mp3HeaderReader.Result r = Mp3HeaderReader.read(new ByteArrayInputStream(data), 1044L * 3);
        assertEquals(1, r.version);
        assertEquals(3, r.layer);
        assertEquals(44100, r.sampleRate);
        assertEquals(2, r.channels);
        assertEquals(320000, r.frameBitrate);
        assertEquals(320000, r.bitrate);
        assertEquals(1044, r.frameLength);
        assertEquals(1152, r.samplesPerFrame);
        assertEquals(1152L * 3, r.totalSamples);
        assertFalse(r.vbr);
        assertEquals("MPEG 1 Layer 3", r.codec);
    }

    @Test
    public void parsesMonoAndMpeg2() {
        Mp3HeaderReader.Result mono = Mp3HeaderReader.parseHeader(TestBytes.builder().bytes(V1_L3_128_MONO).build(), 0);
        assertEquals(1, mono.channels);
        assertEquals(128000, mono.frameBitrate);
        assertEquals(417, mono.frameLength);

        Mp3HeaderReader.Result v2 = Mp3HeaderReader.parseHeader(TestBytes.builder().bytes(V2_L3_64_22050).build(), 0);
        assertEquals(2, v2.version);
        assertEquals(22050, v2.sampleRate);
        assertEquals(64000, v2.frameBitrate);
        assertEquals(576, v2.samplesPerFrame);
        assertEquals(208, v2.frameLength);
        assertEquals("MPEG 2 Layer 3", v2.codec);
    }

    @Test
    public void readsXingHeaderForVbr() throws IOException {
        // Stereo MPEG-1: side info is 32 bytes, so Xing sits at offset 4 + 32.
        TestBytes first = TestBytes.builder().bytes(V1_L3_320_44100).zeros(32)
            .ascii("Xing").u32be(0x3).u32be(10_000).u32be(4_000_000);
        byte[] frame1 = first.zeros(1044 - first.size()).build();
        byte[] data = TestBytes.builder().bytes(frame1).bytes(frames(V1_L3_320_44100, 1044, 1)).build();
        Mp3HeaderReader.Result r = Mp3HeaderReader.read(new ByteArrayInputStream(data), -1);
        assertTrue(r.vbr);
        // The Xing frame count includes the (silent) Xing frame itself.
        assertEquals(9_999L * 1152, r.totalSamples);
        // 4,000,000 bytes over 9999*1152/44100 s = 261.20 s -> ~122.5 kbps
        assertEquals(122500, r.bitrate, 200);
    }

    @Test
    public void infoHeaderIsCbrButStillGivesSampleCount() throws IOException {
        TestBytes first = TestBytes.builder().bytes(V1_L3_128_MONO).zeros(17)
            .ascii("Info").u32be(0x1).u32be(500);
        byte[] frame1 = first.zeros(417 - first.size()).build();
        byte[] data = TestBytes.builder().bytes(frame1).bytes(frames(V1_L3_128_MONO, 417, 1)).build();
        Mp3HeaderReader.Result r = Mp3HeaderReader.read(new ByteArrayInputStream(data), -1);
        assertFalse(r.vbr);
        assertEquals(499L * 1152, r.totalSamples);
        assertEquals(128000, r.bitrate);
    }

    @Test
    public void readsVbriHeader() throws IOException {
        TestBytes first = TestBytes.builder().bytes(V1_L3_320_44100).zeros(32)
            .ascii("VBRI").u16be(1).u16be(0).u16be(0).u32be(2_000_000).u32be(2000).u16be(0).u16be(0).u16be(0).u16be(0);
        byte[] frame1 = first.zeros(1044 - first.size()).build();
        byte[] data = TestBytes.builder().bytes(frame1).bytes(frames(V1_L3_320_44100, 1044, 1)).build();
        Mp3HeaderReader.Result r = Mp3HeaderReader.read(new ByteArrayInputStream(data), -1);
        assertTrue(r.vbr);
        assertEquals(2000L * 1152, r.totalSamples);
    }

    @Test
    public void skipsGarbageBeforeFirstFrameAndRejectsFalseSyncs() throws IOException {
        // A false sync (FF E0 with reserved layer) then junk, then real frames.
        byte[] data = TestBytes.builder().bytes(0xFF, 0xE1, 0x00, 0x00).fill(100, 0x55).bytes(frames(V1_L3_320_44100, 1044, 2)).build();
        Mp3HeaderReader.Result r = Mp3HeaderReader.read(new ByteArrayInputStream(data), -1);
        assertEquals(44100, r.sampleRate);
        assertEquals(320000, r.bitrate);
    }

    @Test
    public void returnsNullWithoutFrames() throws IOException {
        assertNull(Mp3HeaderReader.read(new ByteArrayInputStream(new byte[5000]), -1));
        assertNull(Mp3HeaderReader.read(new ByteArrayInputStream("fLaC".getBytes()), -1));
        // Invalid bitrate index (1111) and sample-rate index (11) are rejected.
        assertNull(Mp3HeaderReader.parseHeader(TestBytes.builder().bytes(0xFF, 0xFB, 0xF0, 0x00).build(), 0));
        assertNull(Mp3HeaderReader.parseHeader(TestBytes.builder().bytes(0xFF, 0xFB, 0xAC, 0x00).build(), 0));
    }
}
