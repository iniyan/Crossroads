package com.crossroads.player;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Bridges the web player's "now playing" state to {@link MediaPlaybackService}.
 *
 * JS API (Capacitor.registerPlugin('MediaSession')):
 *   update({ title, artist, album, artwork, duration, position, isPlaying })
 *       duration/position in seconds; artwork is a content://, file:// or data: URI.
 *       An empty/missing title clears the session.
 *   clear()
 *   checkPermissions() / requestPermissions()
 *       -> { notifications: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' }
 *       POST_NOTIFICATIONS on Android 13+; always 'granted' below. Only affects whether the
 *       notification is visible, playback and the media session work either way.
 *   addListener('action', ({ action, position }) => ...)
 *       action: 'play' | 'pause' | 'next' | 'prev' | 'seekto' | 'stop'; position in seconds
 *       (seekto only).
 */
@CapacitorPlugin(
    name = "MediaSession",
    permissions = {
        @Permission(alias = MediaSessionPlugin.ALIAS_NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MediaSessionPlugin extends Plugin {

    static final String ALIAS_NOTIFICATIONS = "notifications";
    private static final String TAG = "MediaSession";
    private static final String EVENT_ACTION = "action";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Nullable private MediaPlaybackService service;
    private boolean bound = false;
    /** Last state received while the service was not connected yet; applied on connect. */
    @Nullable private MediaPlaybackService.NowPlaying pending;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((MediaPlaybackService.LocalBinder) binder).getService();
            service.setActionListener(MediaSessionPlugin.this::onMediaAction);
            if (pending != null) {
                service.update(pending);
                pending = null;
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
        }
    };

    @Override
    public void load() {
        Context app = getContext().getApplicationContext();
        Intent intent = new Intent(app, MediaPlaybackService.class);
        try {
            bound = app.bindService(intent, connection, Context.BIND_AUTO_CREATE);
            if (!bound) Logger.error(TAG, "bindService returned false", null);
        } catch (Exception e) {
            Logger.error(TAG, "bindService failed", e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        // Synchronously: on a configuration-change relaunch the new activity's plugin binds in
        // the same main-loop turn, so a deferred release would tear down its freshly bound
        // service instead of ours.
        pending = null;
        if (service != null) {
            service.setActionListener(null);
            service.release();
            service = null;
        }
        if (bound) {
            try {
                getContext().getApplicationContext().unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // already unbound
            }
            bound = false;
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        MediaPlaybackService.NowPlaying state = new MediaPlaybackService.NowPlaying();
        state.title = call.getString("title", "");
        state.artist = call.getString("artist", "");
        state.album = call.getString("album", "");
        state.artwork = call.getString("artwork", "");
        state.durationMs = secondsToMs(call.getDouble("duration", 0d));
        state.positionMs = secondsToMs(call.getDouble("position", 0d));
        state.playing = Boolean.TRUE.equals(call.getBoolean("isPlaying", false));
        mainHandler.post(() -> {
            if (service != null) service.update(state);
            else pending = state;
        });
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        mainHandler.post(() -> {
            pending = null;
            if (service != null) service.clear();
        });
        call.resolve();
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(permissionResult());
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(ALIAS_NOTIFICATIONS) == PermissionState.GRANTED) {
            call.resolve(permissionResult());
            return;
        }
        requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, "notificationsPermissionCallback");
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        call.resolve(permissionResult());
    }

    private JSObject permissionResult() {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.put(ALIAS_NOTIFICATIONS, PermissionState.GRANTED.toString());
        } else {
            PermissionState state = getPermissionState(ALIAS_NOTIFICATIONS);
            result.put(ALIAS_NOTIFICATIONS, state == null ? PermissionState.PROMPT.toString() : state.toString());
        }
        return result;
    }

    private void onMediaAction(String action, long positionMs) {
        JSObject data = new JSObject();
        data.put("action", action);
        if (positionMs >= 0) data.put("position", positionMs / 1000.0);
        notifyListeners(EVENT_ACTION, data);
    }

    private static long secondsToMs(@Nullable Double seconds) {
        if (seconds == null || seconds.isNaN() || seconds.isInfinite() || seconds < 0) return 0;
        return Math.round(seconds * 1000);
    }
}
