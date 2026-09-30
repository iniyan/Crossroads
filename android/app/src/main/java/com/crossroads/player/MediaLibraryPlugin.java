package com.crossroads.player;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.json.JSONObject;

/**
 * Exposes the device's music library (via MediaStore) to the web layer.
 *
 * JS API (Capacitor.registerPlugin('MediaLibrary')):
 *   checkPermissions()   -> { audio: 'granted' | 'prompt' | 'denied' | 'prompt-with-rationale' }
 *   requestPermissions() -> same shape, after prompting the user
 *   getTracks()          -> { tracks: Track[] }
 *
 * The permission needed differs by OS version (READ_MEDIA_AUDIO on 33+,
 * READ_EXTERNAL_STORAGE on 32 and below); both are declared as aliases and
 * the plugin picks the right one at runtime, always reporting it as "audio".
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = MediaLibraryPlugin.ALIAS_AUDIO, strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = MediaLibraryPlugin.ALIAS_STORAGE, strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    static final String ALIAS_AUDIO = "audio";
    static final String ALIAS_STORAGE = "storage";

    private static final String TAG = "MediaLibrary";
    private static final String UNKNOWN_ARTIST = "Unknown Artist";
    private static final String MEDIASTORE_UNKNOWN = "<unknown>";
    private static final Uri ALBUM_ART_URI = Uri.parse("content://media/external/audio/albumart");

    /** The alias that is actually relevant on this OS version. */
    private static String activeAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? ALIAS_AUDIO : ALIAS_STORAGE;
    }

    private JSObject permissionResult() {
        PermissionState state = getPermissionState(activeAlias());
        JSObject result = new JSObject();
        result.put(ALIAS_AUDIO, state == null ? PermissionState.PROMPT.toString() : state.toString());
        return result;
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(permissionResult());
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (getPermissionState(activeAlias()) == PermissionState.GRANTED) {
            call.resolve(permissionResult());
            return;
        }
        requestPermissionForAlias(activeAlias(), call, "audioPermissionCallback");
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void getTracks(PluginCall call) {
        if (getPermissionState(activeAlias()) != PermissionState.GRANTED) {
            call.reject("Audio permission not granted", "PERMISSION_DENIED");
            return;
        }
        bridge.execute(() -> {
            try {
                JSArray tracks = queryTracks();
                JSObject result = new JSObject();
                result.put("tracks", tracks);
                call.resolve(result);
            } catch (Exception e) {
                Logger.error(TAG, "Failed to query MediaStore", e);
                call.reject("Failed to read music library: " + e.getMessage());
            }
        });
    }

    @SuppressWarnings("deprecation")
    private JSArray queryTracks() {
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
        if (hasR) {
            projection.add(MediaStore.Audio.Media.ALBUM_ARTIST);
            projection.add(MediaStore.Audio.Media.BITRATE);
        }

        JSArray tracks = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        String sortOrder = MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC";

        try (Cursor cursor = resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            projection.toArray(new String[0]),
            selection,
            null,
            sortOrder
        )) {
            if (cursor == null) return tracks;

            int colData = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
            int colDisplayName = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
            int colTitle = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
            int colArtist = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
            int colAlbum = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
            int colAlbumId = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);
            int colComposer = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.COMPOSER);
            int colDuration = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
            int colMime = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
            int colAlbumArtist = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM_ARTIST) : -1;
            int colBitrate = hasR ? cursor.getColumnIndex(MediaStore.Audio.Media.BITRATE) : -1;

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

                String album = clean(cursor.getString(colAlbum));
                if (album == null) {
                    File parent = file.getParentFile();
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

                JSObject track = new JSObject();
                track.put("path", path);
                track.put("title", title);
                track.put("artist", artist);
                track.put("album", album);
                track.put("albumArtist", albumArtist);
                track.put("composer", composer);
                track.put("duration", duration);
                track.put("format", format);
                track.put("lossless", lossless);
                track.put("bitrate", bitrate);
                track.put("sampleRate", JSONObject.NULL);
                track.put("bitsPerSample", JSONObject.NULL);
                track.put("picture", picture);
                tracks.put(track);
            }
        }
        return tracks;
    }

    /** Returns null for null, blank, or MediaStore's "<unknown>" placeholder. */
    private static String clean(String value) {
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

    private static String deriveFormat(String mime, String fileName) {
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
    private static Object deriveLossless(String format) {
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
                // M4A/MP4 may carry AAC (lossy) or ALAC (lossless); we cannot tell without parsing.
                return JSONObject.NULL;
        }
    }
}
