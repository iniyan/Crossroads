package com.crossroads.player;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads an ID3v2.2 / 2.3 / 2.4 tag into the app's UPPERCASE Vorbis-style tag names
 * (TIT2 -> TITLE, TPE2 -> ALBUMARTIST, TXXX:MusicBrainz Album Id -> MUSICBRAINZ_ALBUMID,
 * USLT -> UNSYNCEDLYRICS, SYLT -> SYNCEDLYRICS as LRC lines, ...). Pictures (APIC) are
 * only noted, never copied.
 *
 * Pure Java (no Android classes) so it can be unit-tested on the JVM.
 */
public final class Id3v2Reader {

    public static final class Result {
        public int major;
        /** Total tag size on disk including the 10-byte header (and footer when present). */
        public long tagLength;
        /** True when the tag was too large to parse and was skipped (tagLength is still valid). */
        public boolean skipped;
        public boolean hasPicture;
        public final Map<String, List<String>> tags = Bytes.newTags();
    }

    static final int MAX_TAG_BYTES = 32 * 1024 * 1024;
    static final int MAX_FRAMES = 2048;

    private static final Charset UTF_16 = Charset.forName("UTF-16");

    private static final Map<String, String> FRAME_NAMES = new HashMap<>();
    private static final Map<String, String> DESCRIPTION_NAMES = new HashMap<>();
    static {
        String[][] frames = {
            {"TIT2", "TITLE"}, {"TPE1", "ARTIST"}, {"TALB", "ALBUM"}, {"TPE2", "ALBUMARTIST"}, {"TCOM", "COMPOSER"},
            {"TCON", "GENRE"}, {"TRCK", "TRACKNUMBER"}, {"TPOS", "DISCNUMBER"}, {"TYER", "DATE"}, {"TDRC", "DATE"},
            {"TDRL", "RELEASEDATE"}, {"TDOR", "ORIGINALDATE"}, {"TORY", "ORIGINALDATE"}, {"TIT1", "GROUPING"},
            {"TIT3", "SUBTITLE"}, {"TPE3", "CONDUCTOR"}, {"TPE4", "REMIXER"}, {"TEXT", "LYRICIST"}, {"TPUB", "LABEL"},
            {"TSRC", "ISRC"}, {"TBPM", "BPM"}, {"TSST", "DISCSUBTITLE"}, {"TSOA", "ALBUMSORT"}, {"TSOP", "ARTISTSORT"},
            {"TSOT", "TITLESORT"}, {"TSO2", "ALBUMARTISTSORT"}, {"TSOC", "COMPOSERSORT"}, {"TCOP", "COPYRIGHT"},
            {"TENC", "ENCODEDBY"}, {"TSSE", "ENCODER"}, {"TLAN", "LANGUAGE"}, {"TMOO", "MOOD"}, {"TMED", "MEDIA"},
            {"TOPE", "ORIGINALARTIST"}, {"TOAL", "ORIGINALALBUM"}, {"TOLY", "ORIGINALLYRICIST"}, {"TCMP", "COMPILATION"},
            {"TKEY", "INITIALKEY"}, {"TLEN", "LENGTH"}, {"TDTG", "TAGGINGDATE"}, {"TOWN", "FILEOWNER"},
            {"TRSN", "RADIOSTATION"}, {"TRSO", "RADIOSTATIONOWNER"}, {"TOFN", "ORIGINALFILENAME"},
            {"TDLY", "PLAYLISTDELAY"}, {"TPRO", "PRODUCEDNOTICE"}, {"TDEN", "ENCODINGTIME"}, {"TIPL", "INVOLVEDPEOPLE"},
            {"IPLS", "INVOLVEDPEOPLE"}, {"TMCL", "MUSICIANCREDITS"}, {"MVNM", "MOVEMENTNAME"}, {"MVIN", "MOVEMENT"},
            {"GRP1", "GROUPING"}, {"USLT", "UNSYNCEDLYRICS"}, {"SYLT", "SYNCEDLYRICS"}, {"COMM", "COMMENT"},
            {"WOAR", "WEBSITE"}, {"WCOP", "LICENSE"}, {"TDAT", "TDAT"}, {"TIME", "TIME"}, {"TSIZ", "TSIZ"},
            // ID3v2.2
            {"TT2", "TITLE"}, {"TP1", "ARTIST"}, {"TAL", "ALBUM"}, {"TP2", "ALBUMARTIST"}, {"TCM", "COMPOSER"},
            {"TCO", "GENRE"}, {"TRK", "TRACKNUMBER"}, {"TPA", "DISCNUMBER"}, {"TYE", "DATE"}, {"TT1", "GROUPING"},
            {"TT3", "SUBTITLE"}, {"TP3", "CONDUCTOR"}, {"TP4", "REMIXER"}, {"TXT", "LYRICIST"}, {"TPB", "LABEL"},
            {"TRC", "ISRC"}, {"TBP", "BPM"}, {"TCR", "COPYRIGHT"}, {"TEN", "ENCODEDBY"}, {"TSS", "ENCODER"},
            {"TLA", "LANGUAGE"}, {"TOA", "ORIGINALARTIST"}, {"TOT", "ORIGINALALBUM"}, {"TKE", "INITIALKEY"},
            {"TLE", "LENGTH"}, {"ULT", "UNSYNCEDLYRICS"}, {"SLT", "SYNCEDLYRICS"}, {"COM", "COMMENT"}, {"IPL", "INVOLVEDPEOPLE"},
            {"TXX", "TXXX"}, {"UFI", "UFID"}, {"PIC", "APIC"}, {"WXX", "WXXX"}
        };
        for (String[] f : frames) FRAME_NAMES.put(f[0], f[1]);

        String[][] descriptions = {
            {"MUSICBRAINZ ALBUM ID", "MUSICBRAINZ_ALBUMID"}, {"MUSICBRAINZ RELEASE TRACK ID", "MUSICBRAINZ_RELEASETRACKID"},
            {"MUSICBRAINZ TRACK ID", "MUSICBRAINZ_TRACKID"}, {"MUSICBRAINZ ARTIST ID", "MUSICBRAINZ_ARTISTID"},
            {"MUSICBRAINZ ALBUM ARTIST ID", "MUSICBRAINZ_ALBUMARTISTID"}, {"MUSICBRAINZ RELEASE GROUP ID", "MUSICBRAINZ_RELEASEGROUPID"},
            {"MUSICBRAINZ WORK ID", "MUSICBRAINZ_WORKID"}, {"MUSICBRAINZ ALBUM TYPE", "RELEASETYPE"},
            {"MUSICBRAINZ ALBUM STATUS", "RELEASESTATUS"}, {"MUSICBRAINZ ALBUM RELEASE COUNTRY", "RELEASECOUNTRY"},
            {"MUSICBRAINZ DISC ID", "MUSICBRAINZ_DISCID"}, {"ACOUSTID ID", "ACOUSTID_ID"}, {"ACOUSTID FINGERPRINT", "ACOUSTID_FINGERPRINT"},
            {"ALBUM ARTIST", "ALBUMARTIST"}, {"CATALOG NUMBER", "CATALOGNUMBER"}, {"MOVEMENT NAME", "MOVEMENTNAME"},
            {"MOVEMENT TOTAL", "MOVEMENTTOTAL"}, {"ORIGINAL YEAR", "ORIGINALYEAR"}, {"FBPM", "BPM"}
        };
        for (String[] d : descriptions) DESCRIPTION_NAMES.put(d[0], d[1]);
    }

    private Id3v2Reader() {}

    /** 'MusicBrainz Album Id' -> MUSICBRAINZ_ALBUMID; anything else UPPERCASE with underscores. */
    static String canonicalDescription(String description) {
        if (description == null) return null;
        String key = description.trim().replace('_', ' ').replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
        if (key.isEmpty()) return null;
        String mapped = DESCRIPTION_NAMES.get(key);
        return mapped != null ? mapped : key.replace(' ', '_');
    }

    /**
     * Reads a tag from the current stream position. Returns null (consuming at most 10 bytes)
     * when no ID3v2 header is present.
     */
    public static Result read(InputStream in) throws IOException {
        return read(in, -1);
    }

    /**
     * @param fileLength size of the file, or -1 when unknown. A tag larger than
     *                   MAX_TAG_BYTES (or than the file) is not parsed: it is skipped by its
     *                   declared size, so the caller can still find the audio frames after it,
     *                   and the result carries {@code skipped = true} with no tags.
     */
    public static Result read(InputStream in, long fileLength) throws IOException {
        byte[] header = Bytes.readUpTo(in, 10);
        if (header.length < 10 || !Bytes.matches(header, 0, "ID3")) return null;
        int major = header[3] & 0xFF;
        int flags = header[5] & 0xFF;
        int size = Bytes.syncsafe(header, 6);
        if (major < 2 || major > 4 || size < 0) return null;
        long footer = (flags & 0x10) != 0 ? 10 : 0;
        long maxBody = fileLength > 0 ? Math.min(MAX_TAG_BYTES, fileLength) : MAX_TAG_BYTES;
        if (size > maxBody) {
            Result r = new Result();
            r.major = major;
            r.skipped = true;
            r.tagLength = 10 + size + footer;
            Bytes.skipFully(in, size + footer);
            return r;
        }
        byte[] body = Bytes.readUpTo(in, size);
        Result r = parseBody(body, major, flags);
        r.tagLength = 10 + size + footer;
        return r;
    }

    /** Parses a complete tag (header included) held in memory, e.g. a WAV {@code id3 } chunk. */
    public static Result parse(byte[] tag) {
        if (tag.length < 10 || !Bytes.matches(tag, 0, "ID3")) return null;
        int major = tag[3] & 0xFF;
        int flags = tag[5] & 0xFF;
        int size = Bytes.syncsafe(tag, 6);
        if (major < 2 || major > 4 || size < 0) return null;
        int len = Math.min(size, tag.length - 10);
        byte[] body = new byte[len];
        System.arraycopy(tag, 10, body, 0, len);
        Result r = parseBody(body, major, flags);
        r.tagLength = 10 + size + ((flags & 0x10) != 0 ? 10 : 0);
        return r;
    }

    static Result parseBody(byte[] body, int major, int flags) {
        Result r = new Result();
        r.major = major;
        boolean unsync = (flags & 0x80) != 0;
        if (unsync && major < 4) body = deUnsync(body, 0, body.length);
        int pos = 0;
        if ((flags & 0x40) != 0 && major >= 3) {
            // Extended header: v2.3 size excludes the 4-byte size field; v2.4 syncsafe size includes it.
            if (body.length < 4) return r;
            int ext = major == 3 ? (int) Bytes.u32be(body, 0) + 4 : Bytes.syncsafe(body, 0);
            pos = Math.max(0, Math.min(ext, body.length));
        }
        int headerLen = major == 2 ? 6 : 10;
        int idLen = major == 2 ? 3 : 4;
        for (int frames = 0; frames < MAX_FRAMES && pos + headerLen <= body.length; frames++) {
            if (body[pos] == 0) break; // padding
            String id = Bytes.ascii(body, pos, idLen);
            if (!isFrameId(id)) break;
            int size;
            int frameFlags = 0;
            if (major == 2) size = Bytes.u24be(body, pos + 3);
            else if (major == 3) { size = (int) Bytes.u32be(body, pos + 4); frameFlags = Bytes.u16be(body, pos + 8); }
            else { size = Bytes.syncsafe(body, pos + 4); frameFlags = Bytes.u16be(body, pos + 8); }
            pos += headerLen;
            if (size < 0 || pos + size > body.length) break;

            int dataStart = pos;
            int dataLen = size;
            boolean skip = false;
            if (major == 3 && (frameFlags & 0x00C0) != 0) skip = true;       // compressed / encrypted
            if (major == 4) {
                if ((frameFlags & 0x000C) != 0) skip = true;                 // compressed / encrypted
                if ((frameFlags & 0x0001) != 0) { dataStart += 4; dataLen -= 4; } // data length indicator
            }
            if (!skip && dataLen > 0) {
                byte[] data;
                if (major == 4 && ((frameFlags & 0x0002) != 0 || unsync)) data = deUnsync(body, dataStart, dataLen);
                else { data = new byte[dataLen]; System.arraycopy(body, dataStart, data, 0, dataLen); }
                try {
                    handleFrame(id, data, r);
                } catch (RuntimeException ignored) {
                    // One malformed frame must not lose the rest.
                }
            }
            pos += size;
        }
        return r;
    }

    private static boolean isFrameId(String id) {
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
        }
        return true;
    }

    /** Reverses ID3 unsynchronisation (FF 00 -> FF). */
    static byte[] deUnsync(byte[] b, int off, int len) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(len);
        for (int i = off; i < off + len; i++) {
            out.write(b[i]);
            if ((b[i] & 0xFF) == 0xFF && i + 1 < off + len && b[i + 1] == 0) i++;
        }
        return out.toByteArray();
    }

    /** Maps a v2.2 three-letter id onto its v2.3/2.4 equivalent for the special-frame checks. */
    private static String frameKind(String rawId) {
        switch (rawId) {
            case "TXX": return "TXXX";
            case "ULT": return "USLT";
            case "COM": return "COMM";
            case "SLT": return "SYLT";
            case "UFI": return "UFID";
            case "PIC": return "APIC";
            case "WXX": return "WXXX";
            case "POP": return "POPM";
            case "IPL": return "IPLS";
            default: return rawId;
        }
    }

    private static void handleFrame(String rawId, byte[] d, Result r) {
        String kind = frameKind(rawId);
        String name = FRAME_NAMES.get(rawId);
        if (kind.equals("APIC")) { r.hasPicture = true; return; }
        if (kind.equals("TXXX")) {
            int enc = d[0] & 0xFF;
            int[] end = new int[1];
            String desc = readTerminated(d, 1, enc, end);
            String value = decode(d, end[0], d.length - end[0], enc);
            for (String v : splitValues(value)) Bytes.addTag(r.tags, canonicalDescription(desc), v);
            return;
        }
        if (kind.equals("USLT") || kind.equals("COMM")) {
            if (d.length < 4) return;
            int enc = d[0] & 0xFF;
            int[] end = new int[1];
            readTerminated(d, 4, enc, end); // description
            String text = decode(d, end[0], d.length - end[0], enc);
            Bytes.addTag(r.tags, kind.equals("USLT") ? "UNSYNCEDLYRICS" : "COMMENT", text);
            return;
        }
        if (kind.equals("SYLT")) {
            Bytes.addTag(r.tags, "SYNCEDLYRICS", parseSylt(d));
            return;
        }
        if (kind.equals("UFID")) {
            int zero = indexOf(d, 0, (byte) 0, 1);
            if (zero < 0) return;
            String owner = Bytes.ascii(d, 0, zero);
            if (owner.toLowerCase(Locale.ROOT).contains("musicbrainz")) {
                Bytes.addTag(r.tags, "MUSICBRAINZ_TRACKID", Bytes.ascii(d, zero + 1, d.length - zero - 1));
            }
            return;
        }
        if (kind.equals("WXXX")) {
            int enc = d[0] & 0xFF;
            int[] end = new int[1];
            readTerminated(d, 1, enc, end);
            Bytes.addTag(r.tags, "URL", Bytes.ascii(d, end[0], d.length - end[0]));
            return;
        }
        if (kind.equals("POPM")) {
            int zero = indexOf(d, 0, (byte) 0, 1);
            if (zero >= 0 && zero + 1 < d.length) Bytes.addTag(r.tags, "RATING", String.valueOf(d[zero + 1] & 0xFF));
            return;
        }
        if (rawId.charAt(0) == 'W') {
            Bytes.addTag(r.tags, name != null ? name : rawId, Bytes.ascii(d, 0, d.length));
            return;
        }
        boolean textFrame = rawId.charAt(0) == 'T' || kind.equals("IPLS") || kind.equals("MVNM") || kind.equals("MVIN") || kind.equals("GRP1");
        if (!textFrame) return;
        if (name == null) name = rawId;
        int enc = d[0] & 0xFF;
        String text = decode(d, 1, d.length - 1, enc);
        if (kind.equals("TIPL") || kind.equals("IPLS") || kind.equals("TMCL")) {
            String[] parts = splitValues(text);
            for (int i = 0; i + 1 < parts.length; i += 2) Bytes.addTag(r.tags, name, parts[i] + ": " + parts[i + 1]);
            return;
        }
        for (String v : splitValues(text)) {
            if (kind.equals("TCON") || kind.equals("TCO")) v = decodeGenre(v);
            Bytes.addTag(r.tags, name, v);
        }
    }

    /** SYLT -> LRC-style lines "[mm:ss.xx]text" when timestamps are in milliseconds. */
    static String parseSylt(byte[] d) {
        if (d.length < 7) return "";
        int enc = d[0] & 0xFF;
        int format = d[4] & 0xFF; // 1 = MPEG frames, 2 = milliseconds
        int[] end = new int[1];
        readTerminated(d, 6, enc, end); // content descriptor
        int pos = end[0];
        StringBuilder sb = new StringBuilder();
        while (pos < d.length) {
            String text = readTerminated(d, pos, enc, end);
            pos = end[0];
            if (pos + 4 > d.length) break;
            long stamp = Bytes.u32be(d, pos);
            pos += 4;
            if (text.startsWith("\n")) text = text.substring(1);
            if (sb.length() > 0) sb.append('\n');
            if (format == 2) {
                long ms = stamp % 1000;
                long totalSec = stamp / 1000;
                sb.append(String.format(Locale.ROOT, "[%02d:%02d.%02d]", totalSec / 60, totalSec % 60, ms / 10));
            }
            sb.append(text);
        }
        return sb.toString();
    }

    /** Splits null-separated multi-values (ID3v2.4), dropping empties. */
    static String[] splitValues(String text) {
        String[] parts = text.split("\0");
        int n = 0;
        for (String p : parts) if (!p.trim().isEmpty()) n++;
        String[] out = new String[n];
        int i = 0;
        for (String p : parts) if (!p.trim().isEmpty()) out[i++] = p;
        return out;
    }

    private static final String[] ID3V1_GENRES = {
        "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age",
        "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
        "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion",
        "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alt. Rock",
        "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
        "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy",
        "Cult", "Gangsta Rap", "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
        "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro",
        "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk/Rock", "National Folk", "Swing", "Fast-Fusion", "Bebop",
        "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock",
        "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson",
        "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam",
        "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock",
        "Drum Solo", "A Cappella", "Euro-House", "Dance Hall"
    };

    /** "(17)" / "17" -> "Rock"; "(17)Something" -> "Something". */
    static String decodeGenre(String v) {
        String s = v.trim();
        if (s.matches("\\(\\d+\\).+")) return s.substring(s.indexOf(')') + 1).trim();
        String digits = s.matches("\\(\\d+\\)") ? s.substring(1, s.length() - 1) : s;
        if (digits.matches("\\d+")) {
            int idx = Integer.parseInt(digits);
            if (idx >= 0 && idx < ID3V1_GENRES.length) return ID3V1_GENRES[idx];
        }
        return s;
    }

    private static Charset charsetFor(int enc) {
        switch (enc) {
            case 1: return UTF_16;
            case 2: return StandardCharsets.UTF_16BE;
            case 3: return StandardCharsets.UTF_8;
            default: return StandardCharsets.ISO_8859_1;
        }
    }

    static String decode(byte[] d, int off, int len, int enc) {
        if (len <= 0 || off >= d.length) return "";
        len = Math.min(len, d.length - off);
        if (enc == 1 && len >= 2) {
            // UTF-16 with BOM; a missing BOM is treated as little-endian (what Windows taggers write).
            boolean bom = ((d[off] & 0xFF) == 0xFF && (d[off + 1] & 0xFF) == 0xFE) || ((d[off] & 0xFF) == 0xFE && (d[off + 1] & 0xFF) == 0xFF);
            if (!bom) return Bytes.decode(d, off, len & ~1, StandardCharsets.UTF_16LE);
        }
        return Bytes.decode(d, off, enc == 1 || enc == 2 ? len & ~1 : len, charsetFor(enc));
    }

    /** Reads a string terminated by NUL (one byte, or two for UTF-16) and stores the index after it in end[0]. */
    static String readTerminated(byte[] d, int off, int enc, int[] end) {
        boolean wide = enc == 1 || enc == 2;
        int i = off;
        while (i < d.length) {
            if (wide) {
                if (i + 1 < d.length && d[i] == 0 && d[i + 1] == 0) break;
                i += 2;
            } else {
                if (d[i] == 0) break;
                i++;
            }
        }
        String s = decode(d, off, Math.min(i, d.length) - off, enc);
        end[0] = Math.min(d.length, i + (wide ? 2 : 1));
        return s;
    }

    private static int indexOf(byte[] d, int from, byte value, int step) {
        for (int i = from; i < d.length; i += step) if (d[i] == value) return i;
        return -1;
    }
}
