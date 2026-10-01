package com.crossroads.player;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.SharedPreferences;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native pieces of LAN sync (#25) for the phone.
 *
 * JS API (Capacitor.registerPlugin('SyncDiscovery')):
 *   startDiscovery() / stopDiscovery()
 *       NsdManager browse for _crossroads._tcp; every resolved desktop fires
 *       'serviceFound' { name, host, port, txt: { deviceId, name, v } }, 'serviceLost' { name }.
 *       No runtime permission is needed (NSD uses the system resolver, not a raw multicast
 *       socket); NEARBY_WIFI_DEVICES is for Wi-Fi Aware/Direct/RTT, not DNS-SD.
 *   request({ url, method, body, timeoutMs }) -> { status, body }
 *       HTTP from native code, because the WebView page (https://localhost) cannot fetch
 *       http://192.168.x.x (mixed content). Only http://<private IP literal>:<port>/v1/...
 *       is accepted (LanAddress); the request goes over a raw socket (LanHttpClient: no
 *       proxy, no redirects, response capped at 8 MB) so the network security config can keep
 *       cleartext disabled for every platform HTTP stack. Every sync payload is AES-GCM
 *       encrypted by the app layer (src/sync/crypto.mjs) anyway.
 *   getSecret({ key }) -> { value } / setSecret({ key, value }) / deleteSecret({ key })
 *       Keystore-wrapped storage for the pairing keys (SecretStore). A read or write that
 *       fails for a transient reason (Keystore busy, wrapping key not visible while entries
 *       exist) rejects with code "transient" and keeps what is stored; an entry that is
 *       provably unrecoverable resolves { value: null } after being dropped.
 *   getState() -> { value } / setState({ value })
 *       The small sync record (peer list, watermarks) in its own SharedPreferences file,
 *       excluded from backups together with the secrets (a restored peer list without its
 *       keys would only promise syncs that cannot work).
 */
@CapacitorPlugin(name = "SyncDiscovery")
public class SyncDiscoveryPlugin extends Plugin {

    private static final String TAG = "SyncDiscovery";
    static final String SERVICE_TYPE = "_crossroads._tcp.";
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_BODY_BYTES = 8 * 1024 * 1024;
    private static final int DEFAULT_TIMEOUT_MS = 20_000;
    static final String STATE_PREFS = "crossroads_sync_state";
    private static final String STATE_KEY = "record";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Deque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private boolean resolving = false;

    @Nullable private NsdManager nsd;
    @Nullable private NsdManager.DiscoveryListener discoveryListener;
    private SecretStore secrets;
    private SharedPreferences statePrefs;

    @Override
    public void load() {
        nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        secrets = new SecretStore(getContext());
        statePrefs = getContext().getApplicationContext().getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE);
    }

    @Override
    protected void handleOnDestroy() {
        stopDiscoveryInternal();
        io.shutdownNow();
    }

    // ---- discovery ----

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (nsd == null) {
            call.reject("Network service discovery is not available");
            return;
        }
        mainHandler.post(() -> {
            if (discoveryListener != null) {
                call.resolve();
                return;
            }
            NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
                @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    Logger.error(TAG, "discovery start failed: " + errorCode, null);
                    mainHandler.post(() -> { if (discoveryListener == this) discoveryListener = null; });
                }
                @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    Logger.error(TAG, "discovery stop failed: " + errorCode, null);
                }
                @Override public void onDiscoveryStarted(String serviceType) {}
                @Override public void onDiscoveryStopped(String serviceType) {}
                @Override public void onServiceFound(NsdServiceInfo info) {
                    if (info.getServiceType() == null || !info.getServiceType().contains("_crossroads._tcp")) return;
                    mainHandler.post(() -> enqueueResolve(info));
                }
                @Override public void onServiceLost(NsdServiceInfo info) {
                    JSObject data = new JSObject();
                    data.put("name", info.getServiceName());
                    notifyListeners("serviceLost", data);
                }
            };
            try {
                nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
                discoveryListener = listener;
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start discovery: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        mainHandler.post(() -> {
            stopDiscoveryInternal();
            call.resolve();
        });
    }

    private void stopDiscoveryInternal() {
        if (nsd != null && discoveryListener != null) {
            try {
                nsd.stopServiceDiscovery(discoveryListener);
            } catch (Exception e) {
                Logger.error(TAG, "stopServiceDiscovery failed", e);
            }
        }
        discoveryListener = null;
        resolveQueue.clear();
    }

    // NsdManager resolves one service at a time (FAILURE_ALREADY_ACTIVE otherwise): queue them.
    private void enqueueResolve(NsdServiceInfo info) {
        resolveQueue.addLast(info);
        resolveNext();
    }

    @SuppressWarnings("deprecation")
    private void resolveNext() {
        if (resolving || nsd == null || discoveryListener == null) return;
        NsdServiceInfo next = resolveQueue.pollFirst();
        if (next == null) return;
        resolving = true;
        nsd.resolveService(next, new NsdManager.ResolveListener() {
            @Override public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                Logger.warn(TAG, "resolve failed for " + info.getServiceName() + ": " + errorCode);
                mainHandler.post(() -> { resolving = false; resolveNext(); });
            }
            @Override public void onServiceResolved(NsdServiceInfo info) {
                String host = pickAddress(info);
                if (host != null && info.getPort() > 0) {
                    JSObject txt = new JSObject();
                    Map<String, byte[]> attributes = info.getAttributes();
                    if (attributes != null) {
                        for (Map.Entry<String, byte[]> entry : attributes.entrySet()) {
                            txt.put(entry.getKey(), entry.getValue() == null ? "" : new String(entry.getValue(), StandardCharsets.UTF_8));
                        }
                    }
                    JSObject data = new JSObject();
                    data.put("name", info.getServiceName());
                    data.put("host", host);
                    data.put("port", info.getPort());
                    data.put("txt", txt);
                    notifyListeners("serviceFound", data);
                }
                mainHandler.post(() -> { resolving = false; resolveNext(); });
            }
        });
    }

    /** Prefers an IPv4 address (IPv6 link-local needs a zone id the URL layer cannot carry). */
    @Nullable
    static String pickAddress(NsdServiceInfo info) {
        InetAddress fallback = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            List<InetAddress> addresses = info.getHostAddresses();
            for (InetAddress address : addresses) {
                if (address instanceof Inet4Address) return address.getHostAddress();
                if (fallback == null) fallback = address;
            }
        } else {
            fallback = info.getHost();
        }
        if (fallback == null) return null;
        String literal = fallback.getHostAddress();
        return literal != null && LanAddress.isPrivateLiteral(literal) ? literal : null;
    }

    // ---- HTTP ----

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        String body = call.getString("body", "");
        int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        LanAddress.Target target = LanAddress.parse(url);
        if (target == null) {
            call.reject("Address not allowed: sync only talks to private LAN addresses");
            return;
        }
        if (!"GET".equals(method) && !"POST".equals(method)) {
            call.reject("Method not allowed");
            return;
        }
        if (body != null && body.length() > MAX_BODY_BYTES) {
            call.reject("Request body too large");
            return;
        }
        final int timeout = Math.max(1000, Math.min(timeoutMs, 120_000));
        final String requestBody = body == null ? "" : body;
        io.execute(() -> {
            try {
                LanHttpClient.Response response = LanHttpClient.request(target.host, target.port, method, target.pathAndQuery, requestBody, timeout, MAX_RESPONSE_BYTES);
                JSObject result = new JSObject();
                result.put("status", response.status);
                result.put("body", response.body);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not reach the computer: " + e.getMessage(), "network");
            } catch (Throwable t) {
                // OutOfMemoryError / StackOverflowError while reading a hostile reply: the request
                // failed, the app must not. Rejecting lets the JS side report it like any failure.
                Logger.error(TAG, "request failed fatally", t);
                call.reject("Could not read the computer's reply: " + t.getClass().getSimpleName(), "network");
            }
        });
    }

    // ---- secrets ----

    @PluginMethod
    public void getSecret(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) { call.reject("key required"); return; }
        io.execute(() -> {
            try {
                JSObject result = new JSObject();
                String value = secrets.get(key);
                if (value == null) result.put("value", JSObject.NULL);
                else result.put("value", value);
                call.resolve(result);
            } catch (SecretStore.TransientException e) {
                call.reject(e.getMessage(), "transient");
            }
        });
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty() || value == null) { call.reject("key and value required"); return; }
        io.execute(() -> {
            try {
                secrets.set(key, value);
                call.resolve();
            } catch (SecretStore.TransientException e) {
                call.reject("Could not store the pairing key right now: " + e.getMessage(), "transient");
            } catch (Exception e) {
                Logger.error(TAG, "setSecret failed", e);
                call.reject("Could not store the pairing key securely: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) { call.reject("key required"); return; }
        io.execute(() -> {
            secrets.delete(key);
            call.resolve();
        });
    }

    // ---- sync record ----

    @PluginMethod
    public void getState(PluginCall call) {
        String value = statePrefs.getString(STATE_KEY, null);
        JSObject result = new JSObject();
        if (value == null) result.put("value", JSObject.NULL);
        else result.put("value", value);
        call.resolve(result);
    }

    @PluginMethod
    public void setState(PluginCall call) {
        String value = call.getString("value");
        if (value == null) { call.reject("value required"); return; }
        io.execute(() -> {
            if (statePrefs.edit().putString(STATE_KEY, value).commit()) call.resolve();
            else call.reject("Could not save the sync state");
        });
    }
}
