package com.crossroads.player;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.ref.WeakReference;

import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Exposes the device's music library (via MediaStore) to the web layer.
 *
 * JS API (Capacitor.registerPlugin('MediaLibrary')):
 *   checkPermissions()   -> { audio: 'granted' | 'prompt' | 'denied' | 'prompt-with-rationale' }
 *   requestPermissions() -> same shape, after prompting the user
 *   getTracks({ budgetMs?, modelVersion? }) -> { tracks: Track[], complete: boolean, pending: number }
 *   getTrackDetails({ path, modelVersion? }) -> { track: Track | null }  (all tags, lyrics included)
 *   event 'libraryIndexed' -> fired when a background indexing pass finishes (see LibraryIndexer)
 *
 * Track objects follow the raw Song model in src/library/song.js: MediaStore columns plus
 * the file's real audio properties and all of its tags (LibraryIndexer / AudioFileProbe),
 * cached natively so unchanged files are not re-parsed. Rows returned before their file was
 * probed carry provisional = true.
 *
 * Indexing runs on this plugin's own thread, never on Capacitor's shared plugin executor:
 * a getTracks() call must not stall Preferences writes or MediaSession updates.
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
    private static final String EVENT_INDEXED = "libraryIndexed";

    /** Runs the (I/O bound) library work off Capacitor's shared plugin thread. */
    private static final ExecutorService LIBRARY_EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "crossroads-library");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });

    /**
     * The plugin instance currently attached to a live activity. The background indexing
     * pass outlives activities (it runs on a process-wide thread), so its completion is
     * delivered through this process-level slot rather than to whichever instance started
     * it; a weak reference keeps a destroyed plugin (and its activity) collectable.
     */
    private static final Object CURRENT_LOCK = new Object();
    private static WeakReference<MediaLibraryPlugin> current = new WeakReference<>(null);

    @Override
    public void load() {
        synchronized (CURRENT_LOCK) {
            current = new WeakReference<>(this);
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (CURRENT_LOCK) {
            if (current.get() == this) current = new WeakReference<>(null);
        }
    }

    /** Delivers {@code libraryIndexed} to the live plugin instance, if any. */
    static void notifyIndexed(int probed) {
        MediaLibraryPlugin plugin;
        synchronized (CURRENT_LOCK) {
            plugin = current.get();
        }
        if (plugin == null) {
            Logger.info(TAG, "Background indexing finished with no live plugin; the next getTracks() serves it from the cache");
            return;
        }
        JSObject event = new JSObject();
        event.put("probed", probed);
        plugin.notifyListeners(EVENT_INDEXED, event);
    }

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

    private static int modelVersionOf(PluginCall call) {
        Integer v = call.getInt("modelVersion", 0);
        return v == null || v < 0 ? 0 : v;
    }

    @PluginMethod
    public void getTracks(PluginCall call) {
        if (getPermissionState(activeAlias()) != PermissionState.GRANTED) {
            call.reject("Audio permission not granted", "PERMISSION_DENIED");
            return;
        }
        final long budgetMs = Math.max(0, call.getLong("budgetMs", LibraryIndexer.DEFAULT_BUDGET_MS));
        final int modelVersion = modelVersionOf(call);
        LIBRARY_EXECUTOR.execute(() -> {
            try {
                LibraryIndexer indexer = new LibraryIndexer(getContext());
                LibraryIndexer.Result indexed = indexer.index(budgetMs, modelVersion);
                JSObject result = new JSObject();
                result.put("tracks", indexed.tracks);
                result.put("complete", indexed.pending.isEmpty());
                result.put("pending", indexed.pending.size());
                call.resolve(result);
                if (!indexed.pending.isEmpty()) {
                    final int count = indexed.pending.size();
                    // A static method reference: the pass must not keep this instance alive.
                    indexer.continueInBackground(indexed.pending, () -> MediaLibraryPlugin.notifyIndexed(count));
                }
            } catch (Exception e) {
                Logger.error(TAG, "Failed to query MediaStore", e);
                call.reject("Failed to read music library: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getTrackDetails(PluginCall call) {
        if (getPermissionState(activeAlias()) != PermissionState.GRANTED) {
            call.reject("Audio permission not granted", "PERMISSION_DENIED");
            return;
        }
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        final int modelVersion = modelVersionOf(call);
        LIBRARY_EXECUTOR.execute(() -> {
            try {
                JSObject track = new LibraryIndexer(getContext()).details(path, modelVersion);
                JSObject result = new JSObject();
                result.put("track", track == null ? JSONObject.NULL : track);
                call.resolve(result);
            } catch (Exception e) {
                Logger.error(TAG, "Failed to read track details", e);
                call.reject("Failed to read track details: " + e.getMessage());
            }
        });
    }
}
