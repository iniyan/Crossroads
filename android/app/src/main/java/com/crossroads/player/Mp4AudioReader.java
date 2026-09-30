package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads the {@code moov} atom of an MP4 / M4A file: the audio sample description (codec
 * fourcc, channels, bit depth, sample rate; the ALAC magic cookie and AAC {@code esds} for
 * their specifics), the media header for duration and the iTunes {@code ilst} tags. Android
 * has no ALAC decoder, so MediaExtractor cannot be relied on to identify it; this reader can.
 * {@code mdat} is never read.
 *
 * Pure Java (no Android classes) so it can be unit-tested on the JVM.
 */
public final class Mp4AudioReader {

    public static final class Result {
        /** AAC, ALAC, FLAC, MP3, OPUS, PCM, AC3, EAC3 or the raw fourcc. */
        public String codec;
        public int channels;
        public int sampleRate;
        public int bitsPerSample;
        public long totalSamples = -1;
        public double duration = -1;
        public int bitrate;
        public boolean hasPicture;
        public final Map<String, List<String>> tags = Bytes.newTags();
    }

    static final long MAX_MOOV_BYTES = 32L * 1024 * 1024;
    static final int MAX_DEPTH = 12;
    /** 'wave' atoms may nest sample-entry children; hostile files nest them without end. */
    static final int MAX_SAMPLE_ENTRY_DEPTH = 4;

    private static final Map<String, String> ATOM_NAMES = new HashMap<>();
    static {
        String[][] atoms = {
            {"©nam", "TITLE"}, {"©ART", "ARTIST"}, {"©alb", "ALBUM"}, {"aART", "ALBUMARTIST"}, {"©wrt", "COMPOSER"},
            {"©gen", "GENRE"}, {"gnre", "GENRE"}, {"©day", "DATE"}, {"trkn", "TRACKNUMBER"}, {"disk", "DISCNUMBER"},
            {"©lyr", "UNSYNCEDLYRICS"}, {"©cmt", "COMMENT"}, {"©grp", "GROUPING"}, {"©wrk", "WORK"}, {"©mvn", "MOVEMENTNAME"},
            {"©mvi", "MOVEMENT"}, {"©mvc", "MOVEMENTTOTAL"}, {"shwm", "SHOWMOVEMENT"}, {"cpil", "COMPILATION"},
            {"tmpo", "BPM"}, {"©too", "ENCODER"}, {"cprt", "COPYRIGHT"}, {"soal", "ALBUMSORT"}, {"soar", "ARTISTSORT"},
            {"sonm", "TITLESORT"}, {"soaa", "ALBUMARTISTSORT"}, {"soco", "COMPOSERSORT"}, {"pgap", "GAPLESS"},
            {"desc", "DESCRIPTION"}, {"ldes", "LONGDESCRIPTION"}, {"©enc", "ENCODEDBY"}, {"catg", "CATEGORY"},
            {"keyw", "KEYWORDS"}, {"purd", "PURCHASEDATE"}, {"rtng", "RATING"}, {"stik", "MEDIATYPE"}, {"ownr", "OWNER"}
        };
        for (String[] a : atoms) ATOM_NAMES.put(a[0], a[1]);
    }

    private Mp4AudioReader() {}

    /**
     * @param in stream positioned at the start of the file.
     * @return the parsed data, or null when the stream is not an MP4 with an audio track.
     */
    public static Result read(InputStream in) throws IOException {
        return read(in, -1);
    }

    /**
     * @param in         stream positioned at the start of the file.
     * @param fileLength size of the file, or -1 when unknown; a moov atom claiming more than
     *                   that is rejected before anything is allocated.
     */
    public static Result read(InputStream in, long fileLength) throws IOException {
        long maxMoov = fileLength > 0 ? Math.min(MAX_MOOV_BYTES, fileLength) : MAX_MOOV_BYTES;
        Result r = new Result();
        boolean sawFtyp = false;
        boolean sawMoov = false;
        for (int atoms = 0; atoms < 64; atoms++) {
            byte[] header = Bytes.readUpTo(in, 8);
            if (header.length < 8) break;
            long size = Bytes.u32be(header, 0);
            String type = Bytes.ascii(header, 4, 4);
            int headerLen = 8;
            if (size == 1) {
                byte[] large = Bytes.readUpTo(in, 8);
                if (large.length < 8) break;
                size = Bytes.u64be(large, 0);
                headerLen = 16;
            } else if (size == 0) {
                size = -1; // to end of file
            }
            if (atoms == 0 && !type.equals("ftyp") && !type.equals("moov") && !type.equals("mdat") && !type.equals("free") && !type.equals("wide")) return null;
            if (type.equals("ftyp")) sawFtyp = true;
            if (type.equals("moov")) {
                long payload = size - headerLen;
                if (payload <= 0 || payload > maxMoov) return null;
                byte[] moov = Bytes.readFully(in, (int) payload);
                parseChildren(moov, 0, moov.length, r, 0, null);
                sawMoov = true;
                break;
            }
            if (size < 0) break;
            if (!Bytes.skipFully(in, size - headerLen)) break;
        }
        if (!sawMoov || (!sawFtyp && r.codec == null)) return null;
        return r.codec != null ? r : null;
    }

    private static final class TrackState {
        boolean sound;
        long timescale;
        long duration = -1;
    }

    static void parseChildren(byte[] b, int start, int end, Result r, int depth, TrackState track) {
        if (depth > MAX_DEPTH) return;
        int pos = start;
        while (pos + 8 <= end) {
            long size = Bytes.u32be(b, pos);
            String type = Bytes.ascii(b, pos + 4, 4);
            int headerLen = 8;
            if (size == 1 && pos + 16 <= end) { size = Bytes.u64be(b, pos + 8); headerLen = 16; }
            else if (size == 0) size = end - pos;
            if (size < headerLen || pos + size > end) break;
            int bodyStart = pos + headerLen;
            int bodyEnd = (int) (pos + size);
            switch (type) {
                case "trak": {
                    TrackState t = new TrackState();
                    parseChildren(b, bodyStart, bodyEnd, r, depth + 1, t);
                    break;
                }
                case "mdia":
                case "minf":
                case "stbl":
                case "udta":
                case "ilst":
                    parseChildren(b, bodyStart, bodyEnd, r, depth + 1, track);
                    break;
                case "meta":
                    // Full box: 4 bytes version/flags precede the children.
                    parseChildren(b, bodyStart + 4, bodyEnd, r, depth + 1, track);
                    break;
                case "hdlr":
                    if (track != null && bodyStart + 12 <= bodyEnd && Bytes.matches(b, bodyStart + 8, "soun")) track.sound = true;
                    break;
                case "mdhd":
                    if (track != null) parseMdhd(b, bodyStart, bodyEnd, track);
                    break;
                case "stsd":
                    // hdlr precedes minf inside mdia, so the handler type is known by now.
                    if (track != null && track.sound && r.codec == null) parseStsd(b, bodyStart, bodyEnd, r, track);
                    break;
                default:
                    if (depth >= 1 && isIlstItem(b, pos, end)) parseIlstItem(type, b, bodyStart, bodyEnd, r);
                    break;
            }
            pos = bodyEnd;
        }
    }

    /** An ilst item is any atom whose first child is a 'data' (or 'mean'/'name') atom. */
    private static boolean isIlstItem(byte[] b, int pos, int end) {
        int child = pos + 16;
        if (child > end) return false;
        return Bytes.matches(b, pos + 12, "data") || Bytes.matches(b, pos + 12, "mean");
    }

    private static void parseMdhd(byte[] b, int start, int end, TrackState t) {
        if (start + 4 > end) return;
        int version = b[start] & 0xFF;
        if (version == 1) {
            if (start + 32 > end) return;
            t.timescale = Bytes.u32be(b, start + 20);
            t.duration = Bytes.u64be(b, start + 24);
        } else {
            if (start + 24 > end) return;
            t.timescale = Bytes.u32be(b, start + 12);
            t.duration = Bytes.u32be(b, start + 16);
        }
    }

    private static void parseStsd(byte[] b, int start, int end, Result r, TrackState t) {
        int pos = start + 8; // version/flags + entry count
        if (pos + 8 > end) return;
        long entrySize = Bytes.u32be(b, pos);
        String fourcc = Bytes.ascii(b, pos + 4, 4);
        int entryEnd = (int) Math.min(end, pos + entrySize);
        int e = pos + 8 + 6 + 2; // reserved(6) + data reference index(2)
        if (e + 20 > entryEnd) return;
        int version = Bytes.u16be(b, e);
        r.channels = Bytes.u16be(b, e + 8);
        r.bitsPerSample = Bytes.u16be(b, e + 10);
        r.sampleRate = (int) (Bytes.u32be(b, e + 16) >>> 16);
        int childrenStart = e + 20;
        if (version == 1) childrenStart += 16;
        else if (version == 2) {
            // QuickTime v2 sound description: 64-bit sample rate + 32-bit channels follow.
            if (e + 20 + 36 <= entryEnd) {
                r.sampleRate = (int) Math.round(Double.longBitsToDouble(Bytes.u64be(b, e + 20 + 4)));
                r.channels = (int) Bytes.u32be(b, e + 20 + 12);
                r.bitsPerSample = (int) Bytes.u32be(b, e + 20 + 20);
            }
            childrenStart = e + 20 + 36;
        }
        r.codec = codecFor(fourcc);
        if (childrenStart < entryEnd) parseSampleEntryChildren(b, childrenStart, entryEnd, r, 0);
        if (t.duration > 0 && t.timescale > 0) {
            r.duration = (double) t.duration / t.timescale;
            if (t.timescale == r.sampleRate) r.totalSamples = t.duration;
            else if (r.sampleRate > 0) r.totalSamples = Math.round(r.duration * r.sampleRate);
        }
        if (r.bitrate <= 0 && r.codec.equals("PCM") && r.sampleRate > 0) r.bitrate = r.sampleRate * r.channels * r.bitsPerSample;
        if (!r.codec.equals("PCM") && !r.codec.equals("ALAC") && !r.codec.equals("FLAC")) r.bitsPerSample = 0;
    }

    static void parseSampleEntryChildren(byte[] b, int start, int end, Result r, int depth) {
        if (depth > MAX_SAMPLE_ENTRY_DEPTH) return;
        int pos = start;
        while (pos + 8 <= end) {
            long size = Bytes.u32be(b, pos);
            String type = Bytes.ascii(b, pos + 4, 4);
            if (size < 8 || pos + size > end) break;
            int bodyStart = pos + 8;
            int bodyEnd = (int) (pos + size);
            switch (type) {
                case "alac":
                    // Magic cookie: version/flags(4) frameLength(4) compat(1) bitDepth(1) pb mb kb(3) channels(1) maxRun(2) maxFrameBytes(4) avgBitRate(4) sampleRate(4)
                    if (bodyStart + 28 <= bodyEnd) {
                        r.bitsPerSample = b[bodyStart + 9] & 0xFF;
                        r.channels = b[bodyStart + 13] & 0xFF;
                        r.bitrate = (int) Bytes.u32be(b, bodyStart + 20);
                        int rate = (int) Bytes.u32be(b, bodyStart + 24);
                        if (rate > 0) r.sampleRate = rate;
                    }
                    break;
                case "esds":
                    parseEsds(b, bodyStart + 4, bodyEnd, r);
                    break;
                case "dfLa":
                    // FLAC-in-MP4: version/flags(4) then METADATA_BLOCK_STREAMINFO with its 4-byte header.
                    if (bodyStart + 4 + 4 + 34 <= bodyEnd) {
                        FlacMetadataReader.Result f = new FlacMetadataReader.Result();
                        byte[] si = new byte[34];
                        System.arraycopy(b, bodyStart + 8, si, 0, 34);
                        FlacMetadataReader.parseStreamInfo(si, f);
                        r.sampleRate = f.sampleRate;
                        r.channels = f.channels;
                        r.bitsPerSample = f.bitsPerSample;
                        if (f.totalSamples > 0) r.totalSamples = f.totalSamples;
                    }
                    break;
                case "btrt":
                    if (bodyStart + 12 <= bodyEnd && r.bitrate <= 0) r.bitrate = (int) Bytes.u32be(b, bodyStart + 8);
                    break;
                case "wave":
                    parseSampleEntryChildren(b, bodyStart, bodyEnd, r, depth + 1);
                    break;
                default:
                    break;
            }
            pos = bodyEnd;
        }
    }

    /** ES_Descriptor -> DecoderConfigDescriptor: object type (0x40 AAC, 0x69/0x6B MP3) and average bitrate. */
    private static void parseEsds(byte[] b, int start, int end, Result r) {
        int pos = start;
        while (pos < end) {
            int tag = b[pos++] & 0xFF;
            int len = 0;
            for (int i = 0; i < 4 && pos < end; i++) {
                int c = b[pos++] & 0xFF;
                len = (len << 7) | (c & 0x7F);
                if ((c & 0x80) == 0) break;
            }
            if (tag == 0x03) {
                // ES_Descriptor: ES_ID(2) flags(1) [+ optional fields]; descend.
                if (pos + 3 > end) return;
                int flags = b[pos + 2] & 0xFF;
                pos += 3;
                if ((flags & 0x80) != 0) pos += 2;
                if ((flags & 0x40) != 0 && pos < end) pos += 1 + (b[pos] & 0xFF);
                if ((flags & 0x20) != 0) pos += 2;
            } else if (tag == 0x04) {
                if (pos + 13 > end) return;
                int objectType = b[pos] & 0xFF;
                int avgBitrate = (int) Bytes.u32be(b, pos + 9);
                if (objectType == 0x69 || objectType == 0x6B) r.codec = "MP3";
                else if (objectType == 0x40 || objectType == 0x66 || objectType == 0x67 || objectType == 0x68) r.codec = "AAC";
                if (avgBitrate > 0) r.bitrate = avgBitrate;
                return;
            } else {
                pos += len;
            }
        }
    }

    static String codecFor(String fourcc) {
        switch (fourcc) {
            case "mp4a": return "AAC";
            case "alac": return "ALAC";
            case "fLaC": return "FLAC";
            case "Opus": return "OPUS";
            case ".mp3": return "MP3";
            case "ac-3": return "AC3";
            case "ec-3": return "EAC3";
            case "lpcm":
            case "sowt":
            case "twos":
            case "in24":
            case "in32":
            case "fl32":
            case "fl64":
            case "raw ":
                return "PCM";
            default: return fourcc.trim().toUpperCase(Locale.ROOT);
        }
    }

    private static void parseIlstItem(String type, byte[] b, int start, int end, Result r) {
        String name = ATOM_NAMES.get(type);
        String freeformName = null;
        int pos = start;
        while (pos + 8 <= end) {
            long size = Bytes.u32be(b, pos);
            String child = Bytes.ascii(b, pos + 4, 4);
            if (size < 8 || pos + size > end) break;
            int bodyStart = pos + 8;
            int bodyEnd = (int) (pos + size);
            if (child.equals("name") && bodyStart + 4 <= bodyEnd) {
                freeformName = new String(b, bodyStart + 4, bodyEnd - bodyStart - 4, StandardCharsets.UTF_8);
            } else if (child.equals("data") && bodyStart + 8 <= bodyEnd) {
                int dataType = Bytes.u24be(b, bodyStart + 1);
                int payload = bodyStart + 8;
                int len = bodyEnd - payload;
                String tagName = type.equals("----") ? Id3v2Reader.canonicalDescription(freeformName) : name;
                if (tagName == null) tagName = Id3v2Reader.canonicalDescription(type.replace("©", ""));
                if (type.equals("covr")) dataType = 13; // any payload type under covr is a picture
                switch (dataType) {
                    case 1:  // UTF-8
                    case 18:
                        Bytes.addTag(r.tags, tagName, new String(b, payload, len, StandardCharsets.UTF_8));
                        break;
                    case 2:  // UTF-16
                        Bytes.addTag(r.tags, tagName, new String(b, payload, len, StandardCharsets.UTF_16BE));
                        break;
                    case 13: // JPEG
                    case 14: // PNG
                        r.hasPicture = true;
                        break;
                    case 21: // BE signed integer
                    case 22: // BE unsigned integer
                    case 65:
                    case 66:
                    case 67:
                    case 74:
                    case 75:
                    case 76:
                    case 77:
                        Bytes.addTag(r.tags, tagName, String.valueOf(readInteger(b, payload, len)));
                        break;
                    case 0:  // implicit: trkn / disk / gnre binary layouts
                        if ((type.equals("trkn") || type.equals("disk")) && len >= 6) {
                            int number = Bytes.u16be(b, payload + 2);
                            int total = Bytes.u16be(b, payload + 4);
                            if (number > 0) Bytes.addTag(r.tags, tagName, total > 0 ? number + "/" + total : String.valueOf(number));
                        } else if (type.equals("gnre") && len >= 2) {
                            int idx = Bytes.u16be(b, payload);
                            if (idx > 0) Bytes.addTag(r.tags, "GENRE", Id3v2Reader.decodeGenre(String.valueOf(idx - 1)));
                        } else if (len > 0 && len <= 4 && (type.equals("cpil") || type.equals("pgap") || type.equals("shwm") || type.equals("tmpo") || type.equals("rtng") || type.equals("stik"))) {
                            Bytes.addTag(r.tags, tagName, String.valueOf(readInteger(b, payload, len)));
                        }
                        break;
                    default:
                        break;
                }
            }
            pos = bodyEnd;
        }
    }

    private static long readInteger(byte[] b, int off, int len) {
        long v = 0;
        for (int i = 0; i < len && i < 8; i++) v = (v << 8) | (b[off + i] & 0xFF);
        return v;
    }
}
