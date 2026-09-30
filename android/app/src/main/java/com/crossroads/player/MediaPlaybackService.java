package com.crossroads.player;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Base64;
import android.util.Size;

import androidx.annotation.MainThread;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Logger;

import java.io.InputStream;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Owns the {@link MediaSessionCompat} and the media-style notification for the player.
 *
 * The audio itself is played by the {@code <audio>} element inside the WebView; this service
 * only mirrors its state (so the lock screen, notification shade, Bluetooth/headset buttons
 * and other apps see a proper media session) and keeps the process alive as a foreground
 * service while playback is running. Transport controls are forwarded to the WebView through
 * {@link ActionListener}, they never touch the audio directly.
 *
 * Lifecycle: {@link MediaSessionPlugin} binds to the service for as long as the activity
 * lives. While playing, the service is additionally promoted to a started foreground service
 * so Android does not kill the process when the app is backgrounded; a few seconds after a
 * pause it drops back out of the foreground (notification stays, becomes dismissable), and
 * when the notification is dismissed or the activity is destroyed the session is released.
 * The grace period matters: the WebView reports a pause right before every track ends, and
 * Android 12+ would not let a backgrounded app start the foreground service again for the
 * next track.
 */
public class MediaPlaybackService extends Service {

    /** Callback for transport controls coming from the session / notification. */
    public interface ActionListener {
        /**
         * @param action   one of {@link #ACTION_PLAY}, {@link #ACTION_PAUSE}, {@link #ACTION_NEXT},
         *                 {@link #ACTION_PREV}, {@link #ACTION_SEEK_TO}, {@link #ACTION_STOP}
         * @param position seek target in milliseconds (only for {@link #ACTION_SEEK_TO}), else -1
         */
        void onAction(String action, long position);
    }

    /** Snapshot of what the web player is doing. */
    public static final class NowPlaying {
        public String title;
        public String artist;
        public String album;
        /** content://, file://, data: or empty. */
        public String artwork;
        public long durationMs;
        public long positionMs;
        public boolean playing;
    }

    public static final String ACTION_PLAY = "play";
    public static final String ACTION_PAUSE = "pause";
    public static final String ACTION_NEXT = "next";
    public static final String ACTION_PREV = "prev";
    public static final String ACTION_SEEK_TO = "seekto";
    public static final String ACTION_STOP = "stop";

    private static final String TAG = "MediaPlayback";
    private static final String CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 0x1234;
    private static final String INTENT_PREFIX = "com.crossroads.player.action.";
    private static final String INTENT_FOREGROUND = INTENT_PREFIX + "FOREGROUND";
    private static final int ARTWORK_SIZE_PX = 512;
    /** Refreshed on every update while playing (the web layer reports position every few seconds). */
    private static final long WAKE_LOCK_TIMEOUT_MS = 15 * 60 * 1000L;
    /** How long the foreground service (and wake lock) outlive a pause before we let go of them. */
    private static final long FOREGROUND_LINGER_MS = 10 * 1000L;
    /** Upper bound for onStartCommand() to answer a startForegroundService() request. */
    private static final long FOREGROUND_START_TIMEOUT_MS = 10 * 1000L;

    private static final long SESSION_ACTIONS =
        PlaybackStateCompat.ACTION_PLAY |
        PlaybackStateCompat.ACTION_PAUSE |
        PlaybackStateCompat.ACTION_PLAY_PAUSE |
        PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
        PlaybackStateCompat.ACTION_SEEK_TO |
        PlaybackStateCompat.ACTION_STOP;

    public final class LocalBinder extends Binder {
        public MediaPlaybackService getService() {
            return MediaPlaybackService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();

    private MediaSessionCompat session;
    private NotificationManagerCompat notificationManager;
    private PowerManager.WakeLock wakeLock;
    @Nullable private ActionListener listener;

    private final NowPlaying state = new NowPlaying();
    private boolean hasTrack = false;
    private boolean isForeground = false;
    /** startForegroundService() was called and onStartCommand() has not answered it yet. */
    private boolean foregroundStartPending = false;
    /** The last startForeground() was refused (background start on Android 12+). */
    private boolean foregroundStartDenied = false;
    private boolean notificationShown = false;
    private boolean noisyReceiverRegistered = false;
    /** Set by release(); cleared again when a (new) plugin instance attaches its listener. */
    private boolean released = false;

    private final Runnable leaveForegroundRunnable = this::leaveForeground;
    private final Runnable foregroundStartTimeout = () -> foregroundStartPending = false;

    /** Artwork URI the current bitmap (or in-flight load) belongs to. */
    @Nullable private String artworkKey;
    @Nullable private Bitmap artworkBitmap;

    // Pause when headphones are unplugged / Bluetooth disconnects, like every other player.
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && state.playing) {
                dispatch(ACTION_PAUSE, -1);
            }
        }
    };

    private final MediaSessionCompat.Callback sessionCallback = new MediaSessionCompat.Callback() {
        @Override public void onPlay() { dispatch(ACTION_PLAY, -1); }
        @Override public void onPause() { dispatch(ACTION_PAUSE, -1); }
        @Override public void onSkipToNext() { dispatch(ACTION_NEXT, -1); }
        @Override public void onSkipToPrevious() { dispatch(ACTION_PREV, -1); }
        @Override public void onSeekTo(long pos) { dispatch(ACTION_SEEK_TO, pos); }
        @Override
        public void onStop() {
            // Stop (e.g. a headset's stop button) pauses the web player and drops the notification.
            dispatch(ACTION_STOP, -1);
            onNotificationDismissed();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = NotificationManagerCompat.from(this);
        createChannel();

        session = new MediaSessionCompat(this, "Crossroads");
        session.setCallback(sessionCallback, mainHandler);
        session.setSessionActivity(contentIntent());
        publishPlaybackState();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Crossroads:playback");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (INTENT_FOREGROUND.equals(action)) {
            // Requested by ensureForeground().
            mainHandler.removeCallbacks(foregroundStartTimeout);
            foregroundStartPending = false;
            enterForeground();
        } else if (action != null && action.startsWith(INTENT_PREFIX)) {
            // Notification action buttons / dismiss (delivered as PendingIntent.getService).
            String name = action.substring(INTENT_PREFIX.length()).toLowerCase(Locale.ROOT);
            if (ACTION_STOP.equals(name)) {
                onNotificationDismissed();
            }
            dispatch(name, -1);
        }
        // Never auto-restart: without the WebView there is nothing to control.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away from recents: the WebView (and the audio) is gone.
        release();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        release();
        mainHandler.removeCallbacks(foregroundStartTimeout);
        artworkExecutor.shutdownNow();
        session.release();
        super.onDestroy();
    }

    // ---- API used by MediaSessionPlugin (main thread) -------------------------------------

    @MainThread
    public void setActionListener(@Nullable ActionListener listener) {
        this.listener = listener;
        // A new activity (config-change relaunch) may attach to a service instance that the
        // previous one already released; it starts over with a clean session.
        if (listener != null) released = false;
    }

    /** Mirrors the web player's state into the session and notification. */
    @MainThread
    public void update(NowPlaying next) {
        if (released) return;
        boolean startedPlaying = next.playing && !state.playing;
        boolean trackChanged =
            !Objects.equals(state.title, next.title) ||
            !Objects.equals(state.artist, next.artist) ||
            !Objects.equals(state.album, next.album) ||
            !Objects.equals(state.artwork, next.artwork) ||
            state.durationMs != next.durationMs;

        state.title = next.title;
        state.artist = next.artist;
        state.album = next.album;
        state.artwork = next.artwork;
        state.durationMs = next.durationMs;
        state.positionMs = next.positionMs;
        state.playing = next.playing;
        hasTrack = state.title != null && !state.title.isEmpty();

        if (!hasTrack) {
            clear();
            return;
        }

        if (trackChanged) {
            loadArtwork(state.artwork);
            publishMetadata();
        }
        if (!session.isActive()) session.setActive(true);
        publishPlaybackState();

        if (state.playing) {
            mainHandler.removeCallbacks(leaveForegroundRunnable);
            acquireWakeLock();
            registerNoisyReceiver();
            ensureForeground(startedPlaying);
        } else {
            unregisterNoisyReceiver();
            if (isForeground || foregroundStartPending) {
                // Stay a foreground service (and awake) for a moment: a pause is often just
                // the gap before the next track, and re-promoting from the background is not
                // allowed on Android 12+. Meanwhile show the paused controls.
                if (notificationShown) postNotification();
                mainHandler.removeCallbacks(leaveForegroundRunnable);
                mainHandler.postDelayed(leaveForegroundRunnable, FOREGROUND_LINGER_MS);
            } else {
                leaveForeground();
            }
        }
    }

    /** Nothing to show: hide the notification and deactivate the session (service stays bound). */
    @MainThread
    public void clear() {
        hasTrack = false;
        state.playing = false;
        mainHandler.removeCallbacks(leaveForegroundRunnable);
        releaseWakeLock();
        unregisterNoisyReceiver();
        if (session.isActive()) session.setActive(false);
        publishPlaybackState();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        isForeground = false;
        notificationManager.cancel(NOTIFICATION_ID);
        notificationShown = false;
        stopSelf();
    }

    /**
     * Teardown when the activity goes away: after this the service ignores updates until a new
     * activity attaches (see {@link #setActionListener}) or it is unbound and destroyed.
     */
    @MainThread
    public void release() {
        if (released) return;
        clear();
        released = true;
        listener = null;
        artworkBitmap = null;
        artworkKey = null;
    }

    // ---- internals ------------------------------------------------------------------------

    private void dispatch(String action, long position) {
        ActionListener l = listener;
        if (l == null) {
            Logger.debug(TAG, "No listener for media action " + action);
            return;
        }
        mainHandler.post(() -> l.onAction(action, position));
    }

    private void onNotificationDismissed() {
        // The user swiped the (paused) notification away: drop the session until the next play.
        mainHandler.post(() -> {
            if (!released) clear();
        });
    }

    /**
     * @param startedPlaying this update is a pause -> play transition (as opposed to a periodic
     *                       position refresh while already playing)
     */
    private void ensureForeground(boolean startedPlaying) {
        if (isForeground) {
            // Already foreground: just refresh the notification contents.
            postNotification();
            return;
        }
        if (foregroundStartPending) return; // onStartCommand() will pick up the latest state
        if (foregroundStartDenied && !startedPlaying && !isAppInForeground()) {
            // The system refused us while backgrounded; asking again on every position update
            // only spams the log (and the "restricted" toast). Retry when something changes.
            postNotification();
            return;
        }
        // On Android 12+ the start is refused if the app is in the background and no exemption
        // applies (e.g. the play button of our own notification grants a short exemption, a
        // plain background resume does not). Playback itself is unaffected: the WebView keeps
        // playing, only the "keep the process alive" guarantee is missing until the next
        // allowed start.
        try {
            Intent intent = new Intent(this, MediaPlaybackService.class).setAction(INTENT_FOREGROUND);
            ContextCompat.startForegroundService(this, intent);
            foregroundStartPending = true;
            mainHandler.postDelayed(foregroundStartTimeout, FOREGROUND_START_TIMEOUT_MS);
        } catch (Exception e) {
            Logger.warn(TAG, "Could not start foreground service: " + e.getMessage());
            foregroundStartDenied = true;
            postNotification();
        }
    }

    /** Answers a startForegroundService() request (onStartCommand). */
    private void enterForeground() {
        if (released || !hasTrack) {
            // The track went away between startForegroundService() and onStartCommand(). We
            // still must call startForeground() once to honour the start (else the system
            // kills us), then immediately drop back out.
            try {
                startForegroundCompat(buildNotification());
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            } catch (Exception e) {
                Logger.warn(TAG, "startForeground failed: " + e.getMessage());
            }
            isForeground = false;
            notificationShown = false;
            return;
        }
        if (isForeground) {
            postNotification();
            return;
        }
        try {
            startForegroundCompat(buildNotification());
            isForeground = true;
            notificationShown = true;
            foregroundStartDenied = false;
            if (!state.playing) {
                // Paused meanwhile: keep the foreground state for the usual grace period.
                mainHandler.removeCallbacks(leaveForegroundRunnable);
                mainHandler.postDelayed(leaveForegroundRunnable, FOREGROUND_LINGER_MS);
            }
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException & co: fall back to a plain notification.
            Logger.warn(TAG, "startForeground failed: " + e.getMessage());
            isForeground = false;
            foregroundStartDenied = true;
            postNotification();
        }
    }

    private static boolean isAppInForeground() {
        ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(info);
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    private void startForegroundCompat(Notification notification) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
    }

    /** Runs once the pause grace period is over (or right away when nothing was pending). */
    private void leaveForeground() {
        mainHandler.removeCallbacks(leaveForegroundRunnable);
        if (state.playing) return; // resumed in the meantime
        releaseWakeLock();
        if (isForeground) {
            // Keep the notification (now dismissable) but stop being a foreground service so the
            // system may reclaim the process if it needs to while nothing is playing.
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
            isForeground = false;
        }
        // While paused only refresh a notification that is still on screen; never resurrect one
        // the user dismissed.
        if (notificationShown) postNotification();
    }

    private void postNotification() {
        if (!hasTrack) return;
        try {
            notificationManager.notify(NOTIFICATION_ID, buildNotification());
            notificationShown = true;
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS denied on Android 13+: playback works, just no shade entry.
            Logger.debug(TAG, "Notification suppressed: " + e.getMessage());
        }
    }

    private void publishMetadata() {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, state.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, state.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs > 0 ? state.durationMs : -1);
        if (artworkBitmap != null) {
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artworkBitmap);
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, artworkBitmap);
        }
        session.setMetadata(b.build());
    }

    private void publishPlaybackState() {
        int playbackState = !hasTrack
            ? PlaybackStateCompat.STATE_STOPPED
            : state.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setActions(SESSION_ACTIONS)
                .setState(playbackState, state.positionMs, state.playing ? 1f : 0f, SystemClock.elapsedRealtime())
                .build()
        );
    }

    private Notification buildNotification() {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(state.title)
            .setContentText(state.artist)
            .setSubText(state.album)
            .setLargeIcon(artworkBitmap)
            .setContentIntent(contentIntent())
            .setDeleteIntent(servicePendingIntent(ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(state.playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .addAction(android.R.drawable.ic_media_previous, "Previous", servicePendingIntent(ACTION_PREV))
            .addAction(
                state.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                state.playing ? "Pause" : "Play",
                servicePendingIntent(state.playing ? ACTION_PAUSE : ACTION_PLAY)
            )
            .addAction(android.R.drawable.ic_media_next, "Next", servicePendingIntent(ACTION_NEXT))
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );
        return b.build();
    }

    private PendingIntent contentIntent() {
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent servicePendingIntent(String action) {
        Intent intent = new Intent(this, MediaPlaybackService.class).setAction(INTENT_PREFIX + action.toUpperCase(Locale.ROOT));
        return PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Now playing controls");
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock == null) return;
        try {
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception e) {
            Logger.debug(TAG, "Wake lock unavailable: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    private void registerNoisyReceiver() {
        if (noisyReceiverRegistered) return;
        ContextCompat.registerReceiver(
            this,
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        noisyReceiverRegistered = true;
    }

    private void unregisterNoisyReceiver() {
        if (!noisyReceiverRegistered) return;
        try {
            unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // not registered
        }
        noisyReceiverRegistered = false;
    }

    // ---- artwork --------------------------------------------------------------------------

    private void loadArtwork(@Nullable String uri) {
        String key = uri == null || uri.isEmpty() ? null : uri;
        if (Objects.equals(key, artworkKey)) return; // same art (or same in-flight load)
        artworkKey = key;
        artworkBitmap = null;
        if (key == null) return;
        artworkExecutor.execute(() -> {
            Bitmap bitmap = decodeArtwork(key);
            mainHandler.post(() -> {
                if (released || !key.equals(artworkKey)) return; // track changed meanwhile
                artworkBitmap = bitmap;
                if (bitmap == null || !hasTrack) return;
                publishMetadata();
                if (notificationShown) postNotification();
            });
        });
    }

    /** Runs off the main thread; any failure just means "no artwork". */
    @Nullable
    private Bitmap decodeArtwork(String uri) {
        try {
            if (uri.startsWith("data:")) {
                int comma = uri.indexOf(',');
                if (comma < 0) return null;
                byte[] bytes = Base64.decode(uri.substring(comma + 1), Base64.DEFAULT);
                return scaleDown(BitmapFactory.decodeByteArray(bytes, 0, bytes.length));
            }
            Uri parsed = Uri.parse(uri);
            ContentResolver resolver = getContentResolver();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && "content".equals(parsed.getScheme())) {
                try {
                    return resolver.loadThumbnail(parsed, new Size(ARTWORK_SIZE_PX, ARTWORK_SIZE_PX), null);
                } catch (Exception e) {
                    // fall through to a plain decode (older providers, non-media URIs)
                }
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = resolver.openInputStream(parsed)) {
                if (in == null) return null;
                BitmapFactory.decodeStream(in, null, bounds);
            }
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
            try (InputStream in = resolver.openInputStream(parsed)) {
                if (in == null) return null;
                return scaleDown(BitmapFactory.decodeStream(in, null, opts));
            }
        } catch (Exception | OutOfMemoryError e) {
            Logger.debug(TAG, "Artwork unavailable for " + uri + ": " + e.getMessage());
            return null;
        }
    }

    private static int sampleSize(int width, int height) {
        int sample = 1;
        while (width / (sample * 2) >= ARTWORK_SIZE_PX && height / (sample * 2) >= ARTWORK_SIZE_PX) sample *= 2;
        return sample;
    }

    @Nullable
    private static Bitmap scaleDown(@Nullable Bitmap bitmap) {
        if (bitmap == null) return null;
        int w = bitmap.getWidth(), h = bitmap.getHeight();
        if (w <= ARTWORK_SIZE_PX && h <= ARTWORK_SIZE_PX) return bitmap;
        float scale = Math.min((float) ARTWORK_SIZE_PX / w, (float) ARTWORK_SIZE_PX / h);
        return Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
    }
}
