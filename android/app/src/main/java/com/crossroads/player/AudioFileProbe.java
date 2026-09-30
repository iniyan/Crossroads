package com.crossroads.player;

import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.os.Build;

import com.getcapacitor.Logger;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reads the audio properties and tags of one file into a JSON "details" object that is
 * merged onto the MediaStore row (see LibraryIndexer) and cached (see LibraryIndexDb).
 *
 * FLAC, WAV, MP3 and MP4/M4A are parsed directly from the file with the pure-Java readers
 * (fast, complete tags). Anything else, or a file the readers reject, goes through
 * MediaMetadataRetriever / MediaExtractor, which know a fixed set of tags only.
 *
 * Details keys: sampleRate, bitsPerSample, channels, codec, totalSamples, md5, bitrate,
 * duration, lossless, hasPicture, tags ({NAME: [values]}), source, probeVersion.
 */
final class AudioFileProbe {

    private static final String TAG = "AudioFileProbe";

    /** Bump whenever the readers produce different output; cached rows with an older version are re-probed. */
    static final int PROBE_VERSION = 2;

    /** {@code source} value of a probe that produced nothing; such rows are cached as failed. */
    static final String SOURCE_NONE = "none";

    private static final int BUFFER_SIZE = 64 * 1024;

    private AudioFileProbe() {}

    /**
     * Never throws, whatever the file does to the readers: an unreadable file yields details
     * with source = "none". Errors (StackOverflowError from hostile nesting, OutOfMemoryError
     * from a bogus block size) are caught as well, so the row is still cached as failed and
     * the same file cannot crash every launch.
     */
    static JSONObject probe(File file, String format) {
        JSONObject details = new JSONObject();
        try {
            details.put("probeVersion", PROBE_VERSION);
            boolean done = false;
            try {
                long length = file.length();
                switch (format) {
                    case "FLAC": done = probeFlac(file, length, details); break;
                    case "WAV": done = probeWav(file, length, details); break;
                    case "MP3": done = probeMp3(file, length, details); break;
                    case "M4A":
                    case "MP4":
                    case "M4B":
                    case "ALAC": done = probeMp4(file, length, details); break;
                    default: break;
                }
            } catch (IOException | RuntimeException e) {
                Logger.warn(TAG, "Native parse failed for " + file + ": " + e);
                details = fresh();
            } catch (Throwable t) {
                Logger.error(TAG, "Native parse crashed for " + file + ": " + t, null);
                details = fresh();
            }
            if (!done) {
                try {
                    done = probeWithFramework(file, details);
                } catch (Throwable t) {
                    Logger.error(TAG, "Framework probe crashed for " + file + ": " + t, null);
                    details = fresh();
                    done = false;
                }
            }
            if (!done) details.put("source", SOURCE_NONE);
        } catch (JSONException e) {
            Logger.error(TAG, "JSON failure probing " + file, e);
        }
        return details;
    }

    /** Whether {@code details} records a probe that produced nothing. */
    static boolean isFailed(JSONObject details) {
        return details == null || SOURCE_NONE.equals(details.optString("source", SOURCE_NONE));
    }

    /** A details object with nothing but the version, replacing one a failed reader half-filled. */
    private static JSONObject fresh() throws JSONException {
        JSONObject d = new JSONObject();
        d.put("probeVersion", PROBE_VERSION);
        return d;
    }

    private static InputStream open(File file) throws IOException {
        return new BufferedInputStream(new FileInputStream(file), BUFFER_SIZE);
    }

    private static boolean probeFlac(File file, long length, JSONObject d) throws IOException, JSONException {
        FlacMetadataReader.Result r;
        try (InputStream in = open(file)) {
            r = FlacMetadataReader.read(in, length);
        }
        if (r == null) return false;
        d.put("source", "flac");
        d.put("codec", "FLAC");
        d.put("lossless", true);
        putPositive(d, "sampleRate", r.sampleRate);
        putPositive(d, "bitsPerSample", r.bitsPerSample);
        putPositive(d, "channels", r.channels);
        putPositive(d, "totalSamples", r.totalSamples);
        d.put("md5", r.md5 == null ? JSONObject.NULL : r.md5);
        if (r.totalSamples > 0 && r.sampleRate > 0) {
            double seconds = (double) r.totalSamples / r.sampleRate;
            d.put("duration", seconds);
            d.put("bitrate", Math.round(file.length() * 8 / seconds));
        }
        d.put("hasPicture", r.hasPicture);
        d.put("tags", tagsJson(r.tags));
        return true;
    }

    private static boolean probeWav(File file, long length, JSONObject d) throws IOException, JSONException {
        WavHeaderReader.Result r;
        try (InputStream in = open(file)) {
            r = WavHeaderReader.read(in, length);
        }
        if (r == null) return false;
        d.put("source", "wav");
        d.put("codec", r.isFloat ? "PCM_FLOAT" : "PCM");
        d.put("lossless", true);
        putPositive(d, "sampleRate", r.sampleRate);
        putPositive(d, "bitsPerSample", r.bitsPerSample);
        putPositive(d, "channels", r.channels);
        putPositive(d, "totalSamples", r.totalSamples);
        if (r.totalSamples > 0 && r.sampleRate > 0) d.put("duration", (double) r.totalSamples / r.sampleRate);
        if (r.sampleRate > 0 && r.channels > 0 && r.bitsPerSample > 0) d.put("bitrate", (long) r.sampleRate * r.channels * r.bitsPerSample);
        d.put("hasPicture", r.hasPicture);
        d.put("tags", tagsJson(r.tags));
        return true;
    }

    private static boolean probeMp3(File file, long length, JSONObject d) throws IOException, JSONException {
        Id3v2Reader.Result id3;
        Mp3HeaderReader.Result mp3;
        try (InputStream in = open(file)) {
            in.mark(10);
            id3 = Id3v2Reader.read(in, length);
            if (id3 == null) {
                in.reset();
            }
            long audioBytes = length - (id3 == null ? 0 : id3.tagLength);
            mp3 = Mp3HeaderReader.read(in, audioBytes);
        }
        if (mp3 == null && id3 == null) return false;
        d.put("source", "mp3");
        d.put("lossless", false);
        if (mp3 != null) {
            d.put("codec", mp3.codec);
            putPositive(d, "sampleRate", mp3.sampleRate);
            putPositive(d, "channels", mp3.channels);
            putPositive(d, "bitrate", mp3.bitrate);
            putPositive(d, "totalSamples", mp3.totalSamples);
            if (mp3.totalSamples > 0 && mp3.sampleRate > 0) d.put("duration", (double) mp3.totalSamples / mp3.sampleRate);
        }
        d.put("hasPicture", id3 != null && id3.hasPicture);
        d.put("tags", tagsJson(id3 == null ? Bytes.newTags() : id3.tags));
        return true;
    }

    private static boolean probeMp4(File file, long length, JSONObject d) throws IOException, JSONException {
        Mp4AudioReader.Result r;
        try (InputStream in = open(file)) {
            r = Mp4AudioReader.read(in, length);
        }
        if (r == null) return false;
        d.put("source", "mp4");
        d.put("codec", r.codec);
        boolean lossless = r.codec.equals("ALAC") || r.codec.equals("FLAC") || r.codec.equals("PCM");
        d.put("lossless", lossless);
        putPositive(d, "sampleRate", r.sampleRate);
        putPositive(d, "channels", r.channels);
        if (lossless) putPositive(d, "bitsPerSample", r.bitsPerSample);
        putPositive(d, "totalSamples", r.totalSamples);
        if (r.duration > 0) d.put("duration", r.duration);
        if (r.bitrate > 0) d.put("bitrate", r.bitrate);
        else if (r.duration > 0) d.put("bitrate", Math.round(file.length() * 8 / r.duration));
        d.put("hasPicture", r.hasPicture);
        d.put("tags", tagsJson(r.tags));
        return true;
    }

    /** MediaExtractor for the stream properties, MediaMetadataRetriever for the known tag set. */
    private static boolean probeWithFramework(File file, JSONObject d) throws JSONException {
        boolean any = false;
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime == null || !mime.startsWith("audio/")) continue;
                any = true;
                d.put("codec", codecForMime(mime));
                if (f.containsKey(MediaFormat.KEY_SAMPLE_RATE)) putPositive(d, "sampleRate", f.getInteger(MediaFormat.KEY_SAMPLE_RATE));
                if (f.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) putPositive(d, "channels", f.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                if (f.containsKey(MediaFormat.KEY_BIT_RATE)) putPositive(d, "bitrate", f.getInteger(MediaFormat.KEY_BIT_RATE));
                if (f.containsKey("bits-per-sample")) putPositive(d, "bitsPerSample", f.getInteger("bits-per-sample"));
                else if (f.containsKey(MediaFormat.KEY_PCM_ENCODING)) putPositive(d, "bitsPerSample", bitsForPcmEncoding(f.getInteger(MediaFormat.KEY_PCM_ENCODING)));
                if (f.containsKey(MediaFormat.KEY_DURATION)) {
                    long us = f.getLong(MediaFormat.KEY_DURATION);
                    if (us > 0) d.put("duration", us / 1_000_000.0);
                }
                Boolean lossless = losslessForMime(mime);
                if (lossless != null) d.put("lossless", lossless);
                break;
            }
        } catch (IOException | RuntimeException e) {
            Logger.warn(TAG, "MediaExtractor failed for " + file + ": " + e);
        } finally {
            extractor.release();
        }

        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(file.getAbsolutePath());
            any = true;
            Map<String, List<String>> tags = Bytes.newTags();
            Bytes.addTag(tags, "TITLE", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            Bytes.addTag(tags, "ARTIST", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            Bytes.addTag(tags, "ALBUM", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            Bytes.addTag(tags, "ALBUMARTIST", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            Bytes.addTag(tags, "COMPOSER", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_COMPOSER));
            Bytes.addTag(tags, "GENRE", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_GENRE));
            String year = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR);
            Bytes.addTag(tags, "DATE", year != null ? year : mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE));
            Bytes.addTag(tags, "TRACKNUMBER", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER));
            Bytes.addTag(tags, "DISCNUMBER", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER));
            Bytes.addTag(tags, "WRITER", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_WRITER));
            Bytes.addTag(tags, "AUTHOR", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_AUTHOR));
            Bytes.addTag(tags, "COMPILATION", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_COMPILATION));
            d.put("tags", tagsJson(tags));
            if (!d.has("bitrate")) putPositive(d, "bitrate", parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (!d.has("sampleRate")) putPositive(d, "sampleRate", parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE)));
                if (!d.has("bitsPerSample")) putPositive(d, "bitsPerSample", parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE)));
            }
            if (!d.has("duration")) {
                long ms = parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                if (ms > 0) d.put("duration", ms / 1000.0);
            }
            if (!d.has("codec")) {
                String mime = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE);
                if (mime != null) d.put("codec", codecForMime(mime));
            }
            byte[] picture = mmr.getEmbeddedPicture();
            d.put("hasPicture", picture != null && picture.length > 0);
        } catch (RuntimeException e) {
            Logger.warn(TAG, "MediaMetadataRetriever failed for " + file + ": " + e);
        } finally {
            try {
                mmr.release();
            } catch (IOException ignored) {
                // release() declares IOException from API 29 on.
            }
        }
        if (any) d.put("source", "framework");
        return any;
    }

    static String codecForMime(String mime) {
        String m = mime.toLowerCase(Locale.ROOT);
        if (m.contains("mp4a") || m.contains("aac")) return "AAC";
        if (m.contains("alac")) return "ALAC";
        if (m.contains("flac")) return "FLAC";
        if (m.contains("vorbis")) return "Vorbis";
        if (m.contains("opus")) return "Opus";
        if (m.contains("mpeg") || m.contains("mp3")) return "MPEG Layer 3";
        if (m.contains("raw") || m.contains("wav") || m.contains("pcm")) return "PCM";
        if (m.contains("ac3")) return "AC3";
        if (m.contains("wma") || m.contains("x-ms")) return "WMA";
        return m.startsWith("audio/") ? m.substring(6).toUpperCase(Locale.ROOT) : m.toUpperCase(Locale.ROOT);
    }

    private static Boolean losslessForMime(String mime) {
        String codec = codecForMime(mime);
        switch (codec) {
            case "AAC":
            case "Vorbis":
            case "Opus":
            case "MPEG Layer 3":
            case "AC3":
            case "WMA":
                return false;
            case "ALAC":
            case "FLAC":
            case "PCM":
                return true;
            default:
                return null;
        }
    }

    private static int bitsForPcmEncoding(int encoding) {
        switch (encoding) {
            case 3: return 8;    // AudioFormat.ENCODING_PCM_8BIT
            case 2: return 16;   // ENCODING_PCM_16BIT
            case 21: return 24;  // ENCODING_PCM_24BIT_PACKED
            case 22: return 32;  // ENCODING_PCM_32BIT
            case 4: return 32;   // ENCODING_PCM_FLOAT
            default: return 0;
        }
    }

    private static long parseLong(String value) {
        if (value == null) return -1;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static void putPositive(JSONObject d, String key, long value) throws JSONException {
        if (value > 0) d.put(key, value);
    }

    static JSONObject tagsJson(Map<String, List<String>> tags) throws JSONException {
        JSONObject out = new JSONObject();
        for (Map.Entry<String, List<String>> e : tags.entrySet()) {
            out.put(e.getKey(), new JSONArray(e.getValue()));
        }
        return out;
    }
}
