package com.crossroads.player;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Builds the track list handed to the web layer: MediaStore is the discovery source (one
 * row per music file), and every row is enriched with the file's real audio properties and
 * tags from {@link AudioFileProbe}, served from {@link LibraryIndexDb} whenever the file's
 * size and mtime are unchanged.
 *
 * Probing is bounded: {@link #index} probes for at most the given budget and returns
 * whatever is ready; rows still waiting are flagged {@code provisional: true} so the web
 * layer knows their tags and quality are incomplete. The remainder is probed by
 * {@link #continueInBackground}, after which the plugin fires {@code libraryIndexed} and the
 * web layer re-reads the library (everything is then served from the cache).
 *
 * The bulk payload carries no lyrics text: LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS values
 * are dropped from {@code tags} and {@code hasEmbeddedLyrics} is set instead.
 * {@link #details} returns the full tags of one file on demand.
 */
final class LibraryIndexer {

    private static final String TAG = "LibraryIndexer";
    private static final String UNKNOWN_ARTIST = "Unknown Artist";
    private static final String MEDIASTORE_UNKNOWN = "<unknown>";
    private static final Uri ALBUM_ART_URI = Uri.parse("content://media/external/audio/albumart");

    /**
     * Default time allowed for probing inside a getTracks() call: enough for a few hundred
     * cached-nothing files on first launch, short enough that the library appears at once.
     */
    static final long DEFAULT_BUDGET_MS = 1_500;
    private static final int WRITE_BATCH = 100;

    /** Serialises background probing across calls; a single thread keeps I/O contention low. */
    private static final ExecutorService BACKGROUND = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "crossroads-indexer");
        t.setPriority(Thread.MIN_PRIORITY);
        return t;
    });
    private static final AtomicBoolean BACKGROUND_BUSY = new AtomicBoolean(false);

    static final class Row {
        final JSObject track;
        final String path;
        final String format;
        final long size;
        final long mtime;
        boolean probed;

        Row(JSObject track, String path, String format, long size, long mtime) {
            this.track = track;
            this.path = path;
            this.format = format;
            this.size = size;
            this.mtime = mtime;
        }
    }

    static final class Result {
        final JSArray tracks;
        final List<Row> pending;
        final int probed;
        final int cached;
        final int pruned;

        Result(JSArray tracks, List<Row> pending, int probed, int cached, int pruned) {
            this.tracks = tracks;
            this.pending = pending;
            this.probed = probed;
            this.cached = cached;
            this.pruned = pruned;
        }
    }

    private final Context context;
    private final LibraryIndexDb db;

    LibraryIndexer(Context context) {
        this.context = context.getApplicationContext();
        this.db = LibraryIndexDb.get(this.context);
    }

    /**
     * @param budgetMs     how long to probe uncached files before returning.
     * @param modelVersion the web layer's LIBRARY_MODEL_VERSION; cached rows from another
     *                     version are dropped first.
     */
    Result index(long budgetMs, int modelVersion) {
        long start = SystemClock.elapsedRealtime();
        db.ensureModelVersion(modelVersion);
        List<Row> rows = queryMediaStore(null);
        Map<String, LibraryIndexDb.Cached> cache = db.loadAll();
        long now = System.currentTimeMillis();

        JSArray tracks = new JSArray();
        List<Row> toProbe = new ArrayList<>();
        Set<String> live = new HashSet<>(rows.size() * 2);
        int cached = 0;
        for (Row row : rows) {
            live.add(row.path);
            LibraryIndexDb.Cached hit = cache.get(row.path);
            if (hit != null && hit.isCurrent(row.size, row.mtime, now)) {
                merge(row, hit.details, false);
                row.probed = true;
                cached++;
            } else {
                toProbe.add(row);
            }
        }
        cache.clear();
        // Cheap native parsers first, framework probes (slower) last.
        toProbe.sort((a, b) -> Integer.compare(probeCost(a.format), probeCost(b.format)));

        int probed = probeRows(toProbe, start + budgetMs);

        int pruned = 0;
        try {
            pruned = db.prune(live);
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Pruning the index failed: " + e);
        }

        List<Row> pending = new ArrayList<>();
        for (Row row : toProbe) if (!row.probed) pending.add(row);
        for (Row row : rows) {
            row.track.put("provisional", !row.probed);
            tracks.put(row.track);
        }
        Logger.info(TAG, String.format(Locale.ROOT,
            "Indexed %d tracks: %d cached, %d probed, %d pending, %d pruned in %d ms",
            rows.size(), cached, probed, pending.size(), pruned, SystemClock.elapsedRealtime() - start));
        return new Result(tracks, pending, probed, cached, pruned);
    }

    /**
     * The track for one file with its complete details (all tags, lyrics included), or null
     * when MediaStore does not know the path. Probes the file when the cache has nothing
     * current for it.
     */
    JSObject details(String path, int modelVersion) {
        db.ensureModelVersion(modelVersion);
        List<Row> rows = queryMediaStore(path);
        if (rows.isEmpty()) return null;
        Row row = rows.get(0);
        String json = db.getCurrent(row.path, row.size, row.mtime);
        if (json == null) {
            json = probeAndStore(row);
        }
        merge(row, json, true);
        row.track.put("provisional", false);
        return row.track;
    }

    /** Probes one row, caches the outcome and returns the details JSON. */
    private String probeAndStore(Row row) {
        JSONObject details = AudioFileProbe.probe(new File(row.path), row.format);
        String json = details.toString();
        List<LibraryIndexDb.Entry> batch = new ArrayList<>(1);
        batch.add(new LibraryIndexDb.Entry(row.path, row.size, row.mtime, json, AudioFileProbe.isFailed(details)));
        flush(batch);
        return json;
    }

    /**
     * Probes rows in order until all are done or the deadline passes, writing results to the
     * database in batches. Returns the number probed.
     */
    private int probeRows(List<Row> rows, long deadline) {
        int probed = 0;
        List<LibraryIndexDb.Entry> batch = new ArrayList<>(WRITE_BATCH);
        for (Row row : rows) {
            if (row.probed) continue;
            if (SystemClock.elapsedRealtime() >= deadline) break;
            if (Thread.currentThread().isInterrupted()) break;
            JSONObject details = AudioFileProbe.probe(new File(row.path), row.format);
            String json = details.toString();
            merge(row, json, false);
            row.probed = true;
            probed++;
            batch.add(new LibraryIndexDb.Entry(row.path, row.size, row.mtime, json, AudioFileProbe.isFailed(details)));
            if (batch.size() >= WRITE_BATCH) {
                flush(batch);
            }
        }
        flush(batch);
        return probed;
    }

    private void flush(List<LibraryIndexDb.Entry> batch) {
        if (batch.isEmpty()) return;
        try {
            db.putAll(batch);
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Writing the index failed: " + e);
        }
        batch.clear();
    }

    /**
     * Finishes probing {@code pending} on a low-priority thread and runs {@code onDone} when
     * everything is cached. Only one background pass runs at a time: rows that arrive while
     * one is running are left for the rescan that its completion triggers, which starts a
     * fresh pass for whatever is still missing. {@code onDone} must not capture the plugin
     * instance (see MediaLibraryPlugin.notifyIndexed).
     */
    void continueInBackground(List<Row> pending, Runnable onDone) {
        if (pending.isEmpty()) return;
        if (!BACKGROUND_BUSY.compareAndSet(false, true)) {
            Logger.info(TAG, "Background indexing already running; " + pending.size() + " rows will be picked up next scan");
            return;
        }
        BACKGROUND.execute(() -> {
            int probed = 0;
            try {
                // Re-validate against the cache: another scan may have probed some already.
                Iterator<Row> it = pending.iterator();
                while (it.hasNext()) {
                    Row row = it.next();
                    if (db.getCurrent(row.path, row.size, row.mtime) != null) it.remove();
                }
                probed = probeRows(pending, Long.MAX_VALUE);
                Logger.info(TAG, "Background indexing finished: " + probed + " files probed");
            } catch (RuntimeException e) {
                Logger.error(TAG, "Background indexing failed", e);
            } finally {
                BACKGROUND_BUSY.set(false);
                if (onDone != null) onDone.run();
            }
        });
    }

    private static int probeCost(String format) {
        switch (format) {
            case "FLAC":
            case "WAV":
            case "MP3":
            case "M4A":
            case "MP4":
            case "ALAC":
                return 0;
            default:
                return 1;
        }
    }

    /**
     * Copies the probe details onto the track object; MediaStore values win for what it
     * already knows. With {@code fullTags} false the lyrics tags are replaced by
     * {@code hasEmbeddedLyrics} (bulk payload); with true every tag is passed through.
     */
    static void merge(Row row, String detailsJson, boolean fullTags) {
        JSONObject details;
        try {
            details = new JSONObject(detailsJson);
        } catch (JSONException e) {
            return;
        }
        JSObject track = row.track;
        Iterator<String> keys = details.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            switch (key) {
                case "probeVersion":
                case "source":
                    continue;
                case "bitrate":
                case "duration":
                    // MediaStore's values come from the same headers; only fill gaps.
                    if (track.opt(key) != null && track.opt(key) != JSONObject.NULL) continue;
                    break;
                case "lossless":
                    if (track.opt(key) instanceof Boolean) continue;
                    break;
                case "tags": {
                    JSONObject tags = details.optJSONObject(key);
                    if (tags == null) continue;
                    boolean hasLyrics = false;
                    JSONObject out = new JSONObject();
                    Iterator<String> names = tags.keys();
                    while (names.hasNext()) {
                        String name = names.next();
                        if (isLyricsTag(name)) {
                            hasLyrics = true;
                            if (!fullTags) continue;
                        }
                        try {
                            out.put(name, tags.get(name));
                        } catch (JSONException ignored) {
                            // Unreachable: names come from the same object.
                        }
                    }
                    track.put("tags", out);
                    track.put("hasEmbeddedLyrics", hasLyrics);
                    continue;
                }
                default:
                    break;
            }
            try {
                track.put(key, details.get(key));
            } catch (JSONException ignored) {
                // Unreachable: keys come from the same object.
            }
        }
    }

    /** LYRICS, UNSYNCEDLYRICS, SYNCEDLYRICS and language-suffixed variants (LYRICS:ENG, UNSYNCEDLYRICS-XXX). */
    static boolean isLyricsTag(String name) {
        String n = name.toUpperCase(Locale.ROOT);
        for (String base : new String[] {"LYRICS", "UNSYNCEDLYRICS", "SYNCEDLYRICS"}) {
            if (n.equals(base)) return true;
            if (n.startsWith(base) && n.length() > base.length()) {
                char c = n.charAt(base.length());
                if (c == ':' || c == '-' || c == '_') return true;
            }
        }
        return false;
    }

    // --- MediaStore ---------------------------------------------------------------------------

    /**
     * @param pathFilter when non-null, only the row whose DATA column equals it.
     */
    @SuppressWarnings("deprecation")
    List<Row> queryMediaStore(String pathFilter) {
        final boolean hasR = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;

        List<String> projection = new ArrayList<>();
        projection.add(MediaStore.Audio.Media._ID);
        projection.add(MediaStore.Audio.Media.DATA);
        projection.add(MediaStore.Audio.Media.DISPLAY_NAME);
        projection.add(MediaStore.Audio.Media.TITLE);
        projection.add(MediaStore.Audio.Media.ARTIST);
        projection.add(MediaStore.Audio.Media.ALBUM);
        projection.add(MediaStore.Audio.Media.ALBUM_ID);
        projection.add(MediaStore.Audio.Media.COMPOSER);
        projection.add(MediaStore.Audio.Media.DURATION);
        projection.add(MediaStore.Audio.Media.MIME_TYPE);
        projection.add(MediaStore.Audio.Media.SIZE);
        projection.add(MediaStore.Audio.Media.DATE_MODIFIED);
        projection.add(MediaStore.Audio.Media.TRACK);
        projection.add(MediaStore.Audio.Media.YEAR);
        if (hasR) {
            projection.add(MediaStore.Audio.Media.ALBUM_ARTIST);
            projection.add(MediaStore.Audio.Media.BITRATE);
            projection.add(MediaStore.Audio.Media.DISC_NUMBER);
            projection.add(MediaStore.Audio.Media.GENRE);
        }

        List<Row> rows = new ArrayList<>();
        ContentResolver resolver = context.getContentResolver();
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        String[] selectionArgs = null;
        if (pathFilter != null) {
            selection += " AND " + MediaStore.Audio.Media.DATA + " = ?";
            selectionArgs = new String[] {pathFilter};
        }
        String sortOrder = MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC";

        try (Cursor cursor = resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            projection.toArray(new String[0]),
            selection,
            selectionArgs,
            sortOrder
        )) {
            if (cursor == null) return rows;

            int colData = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
            int colDisplayName = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
            int colTitle = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
            int colArtist = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
            int colAlbum = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
            int colAlbumId = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);
            int colComposer = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.COMPOSER);
            int colDuration = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
            int colMime = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
            int colSize = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
            int colModified = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);
            int colTrack = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK);
            int colYear = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR);
            int colAlbumArtist = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM_ARTIST) : -1;
            int colBitrate = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.BITRATE) : -1;
            int colDisc = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.DISC_NUMBER) : -1;
            int colGenre = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.GENRE) : -1;

            while (cursor.moveToNext()) {
                String path = cursor.getString(colData);
                if (path == null || path.isEmpty()) continue;

                File file = new File(path);
                String fileName = file.getName();
                String displayName = cursor.getString(colDisplayName);
                if (displayName == null || displayName.isEmpty()) displayName = fileName;

                String title = clean(cursor.getString(colTitle));
                if (title == null) title = stripExtension(displayName);

                String artist = clean(cursor.getString(colArtist));
                if (artist == null) artist = UNKNOWN_ARTIST;

                File parent = file.getParentFile();
                String folder = parent != null ? parent.getPath() : "";
                String album = clean(cursor.getString(colAlbum));
                if (album == null) {
                    album = parent != null && parent.getName() != null && !parent.getName().isEmpty()
                        ? parent.getName()
                        : "Unknown Album";
                }

                // Only the explicit tag (ALBUM_ARTIST exists on API 30+): the web layer groups
                // albums by it and labels untagged compilations "Various Artists".
                String albumArtist = colAlbumArtist >= 0 ? clean(cursor.getString(colAlbumArtist)) : null;
                if (albumArtist == null) albumArtist = "";

                String composer = clean(cursor.getString(colComposer));
                if (composer == null) composer = "";

                Object duration = JSONObject.NULL;
                if (!cursor.isNull(colDuration)) {
                    long ms = cursor.getLong(colDuration);
                    if (ms > 0) duration = ms / 1000.0;
                }

                String mime = cursor.getString(colMime);
                String format = deriveFormat(mime, fileName);
                Object lossless = deriveLossless(format);

                Object bitrate = JSONObject.NULL;
                if (colBitrate >= 0 && !cursor.isNull(colBitrate)) {
                    long bps = cursor.getLong(colBitrate);
                    if (bps > 0) bitrate = bps;
                }

                Object picture = JSONObject.NULL;
                if (!cursor.isNull(colAlbumId)) {
                    long albumId = cursor.getLong(colAlbumId);
                    if (albumId > 0) picture = ContentUris.withAppendedId(ALBUM_ART_URI, albumId).toString();
                }

                long size = cursor.isNull(colSize) ? 0 : cursor.getLong(colSize);
                long mtime = cursor.isNull(colModified) ? 0 : cursor.getLong(colModified) * 1000L;

                // MediaStore TRACK packs disc*1000 + track for multi-disc albums.
                Object trackNumber = JSONObject.NULL;
                Object discNumber = JSONObject.NULL;
                if (!cursor.isNull(colTrack)) {
                    long packed = cursor.getLong(colTrack);
                    if (packed > 0) {
                        trackNumber = packed % 1000;
                        if (packed >= 1000) discNumber = packed / 1000;
                    }
                }
                if (colDisc >= 0 && !cursor.isNull(colDisc)) {
                    String disc = clean(cursor.getString(colDisc));
                    if (disc != null) discNumber = disc;
                }
                Object year = JSONObject.NULL;
                if (!cursor.isNull(colYear)) {
                    long y = cursor.getLong(colYear);
                    if (y > 0) year = y;
                }
                Object genre = JSONObject.NULL;
                if (colGenre >= 0) {
                    String g = clean(cursor.getString(colGenre));
                    if (g != null) genre = g;
                }

                JSObject track = new JSObject();
                track.put("path", path);
                track.put("folder", folder);
                track.put("fileSize", size);
                track.put("mtime", mtime);
                track.put("title", title);
                track.put("artist", artist);
                track.put("album", album);
                track.put("albumArtist", albumArtist);
                track.put("composer", composer);
                track.put("genre", genre);
                track.put("year", year);
                track.put("trackNumber", trackNumber);
                track.put("discNumber", discNumber);
                track.put("duration", duration);
                track.put("format", format);
                track.put("lossless", lossless);
                track.put("bitrate", bitrate);
                track.put("sampleRate", JSONObject.NULL);
                track.put("bitsPerSample", JSONObject.NULL);
                track.put("channels", JSONObject.NULL);
                track.put("codec", JSONObject.NULL);
                track.put("totalSamples", JSONObject.NULL);
                track.put("md5", JSONObject.NULL);
                track.put("tags", new JSObject());
                track.put("hasEmbeddedLyrics", false);
                track.put("picture", picture);
                track.put("provisional", true);
                rows.add(new Row(track, path, format, size, mtime));
            }
        }
        return rows;
    }

    /** Returns null for null, blank, or MediaStore's "<unknown>" placeholder. */
    static String clean(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        if (trimmed.isEmpty() || MEDIASTORE_UNKNOWN.equalsIgnoreCase(trimmed)) return null;
        return trimmed;
    }

    private static String stripExtension(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String extensionOf(String fileName) {
        if (fileName == null) return "";
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return "";
        return fileName.substring(dot + 1).toUpperCase(Locale.ROOT);
    }

    static String deriveFormat(String mime, String fileName) {
        String ext = extensionOf(fileName);
        // Prefer the extension when it is a recognisable audio container: it is more
        // specific than MIME (e.g. audio/mp4 can be .m4a or .mp4, audio/ogg may be opus).
        switch (ext) {
            case "FLAC":
            case "MP3":
            case "M4A":
            case "WAV":
            case "OGG":
            case "OPUS":
            case "AAC":
            case "AIFF":
            case "AIF":
            case "WMA":
            case "APE":
            case "MP4":
                return "AIF".equals(ext) ? "AIFF" : ext;
            default:
                break;
        }
        if (mime != null) {
            switch (mime.toLowerCase(Locale.ROOT)) {
                case "audio/flac":
                case "audio/x-flac":
                    return "FLAC";
                case "audio/mpeg":
                case "audio/mp3":
                    return "MP3";
                case "audio/mp4":
                case "audio/x-m4a":
                case "audio/m4a":
                    return "M4A";
                case "audio/wav":
                case "audio/x-wav":
                case "audio/vnd.wave":
                    return "WAV";
                case "audio/ogg":
                case "audio/vorbis":
                    return "OGG";
                case "audio/opus":
                    return "OPUS";
                case "audio/aac":
                case "audio/aacp":
                    return "AAC";
                case "audio/aiff":
                case "audio/x-aiff":
                    return "AIFF";
                default:
                    break;
            }
        }
        return ext.isEmpty() ? "UNKNOWN" : ext;
    }

    /** true for lossless formats, false for lossy, JSONObject.NULL when the container is ambiguous. */
    static Object deriveLossless(String format) {
        switch (format) {
            case "FLAC":
            case "WAV":
            case "AIFF":
            case "APE":
            case "ALAC":
                return Boolean.TRUE;
            case "MP3":
            case "OGG":
            case "OPUS":
            case "AAC":
            case "WMA":
                return Boolean.FALSE;
            default:
                // M4A/MP4 may carry AAC (lossy) or ALAC (lossless); the probe resolves it.
                return JSONObject.NULL;
        }
    }
}
