package com.crossroads.player;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;

/**
 * Exports a PNG rendered by the web app (Crossroads Wrapped, #27).
 *
 * The Android WebView has no Web Share API, so the JS side hands us the PNG bytes:
 *   share({ base64, filename })  writes to the cache dir and opens the system share sheet
 *                                through the app's FileProvider (cache path, see file_paths.xml).
 *
 * The call resolves { shared: true } as soon as the chooser is on screen; whether the user
 * then saved, sent or dismissed is not knowable, so the JS side reports it neutrally. The
 * share directory keeps only the last few images (a share target may still be reading the
 * previous one), older files are pruned before each write.
 */
@CapacitorPlugin(name = "ImageExport")
public class ImageExportPlugin extends Plugin {

    private static final String TAG = "ImageExport";
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final int KEEP_FILES = 5;
    private static final byte[] PNG_SIGNATURE = { (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };

    @PluginMethod
    public void share(PluginCall call) {
        byte[] bytes = decode(call);
        if (bytes == null) return;
        String filename = safeName(call.getString("filename"));
        try {
            Context context = getContext();
            File dir = new File(context.getCacheDir(), "share");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create cache dir");
            prune(dir, filename);
            File file = new File(dir, filename);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType("image/png")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Share image");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooser);
            JSObject result = new JSObject();
            result.put("shared", true);
            call.resolve(result);
        } catch (Exception e) {
            Logger.error(TAG, "share failed", e);
            call.reject("Could not share the image: " + e.getMessage());
        }
    }

    /** Deletes the oldest files in `dir` so that, with `incoming` written, at most KEEP_FILES remain. */
    private static void prune(File dir, String incoming) {
        File[] files = dir.listFiles();
        if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        int kept = 0;
        for (File file : files) {
            if (!file.isFile()) continue;
            if (file.getName().equals(incoming)) continue;   // about to be overwritten anyway
            kept++;
            if (kept >= KEEP_FILES && !file.delete()) {
                Logger.warn(TAG, "could not delete " + file.getName());
            }
        }
    }

    /** Decodes and validates the PNG payload; rejects the call and returns null when invalid. */
    private byte[] decode(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("Missing image data");
            return null;
        }
        if (base64.length() > MAX_BYTES * 4L / 3L) {
            call.reject("Image too large");
            return null;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid image data");
            return null;
        }
        if (bytes.length < PNG_SIGNATURE.length) {
            call.reject("Not a PNG");
            return null;
        }
        for (int i = 0; i < PNG_SIGNATURE.length; i++) {
            if (bytes[i] != PNG_SIGNATURE[i]) {
                call.reject("Not a PNG");
                return null;
            }
        }
        return bytes;
    }

    private static String safeName(String requested) {
        String name = requested == null ? "" : requested.replaceAll("[^A-Za-z0-9._-]", "_");
        if (name.isEmpty() || name.startsWith(".")) name = "crossroads-wrapped.png";
        if (!name.toLowerCase().endsWith(".png")) name = name + ".png";
        return name;
    }
}
