package com.crossroads.player;

import androidx.annotation.Nullable;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Pure validation of the URLs the sync client may open natively (#25). Only
 * {@code http://<private IP literal>:<port>/v1/...} passes: no host names (so no DNS and no
 * rebinding), no public addresses, no other paths. IPv4 RFC 1918 + link-local and IPv6
 * link-local / ULA are accepted; loopback is not (the desktop is never on the phone), nor are
 * IPv6 zone ids (link-local IPv6 needs one; use IPv4 on the LAN instead).
 */
public final class LanAddress {

    private LanAddress() {}

    public static final class Target {
        public final String host;
        public final int port;
        public final String url;
        /** Raw path plus "?query" when present: what goes on the request line. */
        public final String pathAndQuery;

        Target(String host, int port, String url, String pathAndQuery) {
            this.host = host;
            this.port = port;
            this.url = url;
            this.pathAndQuery = pathAndQuery;
        }
    }

    /** The validated target, or null when the URL must not be opened. */
    @Nullable
    public static Target parse(@Nullable String url) {
        if (url == null || url.length() > 2048) return null;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
        if (uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase("http")) return null;
        if (uri.getRawUserInfo() != null || uri.getRawFragment() != null) return null;
        String host = uri.getHost();
        int port = uri.getPort();
        if (host == null || port < 1 || port > 65535) return null;
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if (!isPrivateLiteral(host)) return null;
        String path = uri.getRawPath();
        if (path == null || !path.startsWith("/v1/") || path.contains("/../") || path.contains("//")) return null;
        String query = uri.getRawQuery();
        return new Target(host, port, url, query == null ? path : path + "?" + query);
    }

    /** True for any syntactically valid IPv4/IPv6 literal (any range); never a name. */
    public static boolean isIpLiteral(@Nullable String host) {
        return host != null && !host.isEmpty() && (parseIpv4(host) != null || parseIpv6(host) != null);
    }

    /** True for an IP literal (no names) inside a private LAN range. */
    public static boolean isPrivateLiteral(@Nullable String host) {
        if (host == null || host.isEmpty()) return false;
        int[] v4 = parseIpv4(host);
        if (v4 != null) {
            int a = v4[0], b = v4[1];
            return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
        }
        int[] v6 = parseIpv6(host);
        if (v6 == null) return false;
        int first = v6[0];
        // fe80::/10 link-local, fc00::/7 unique local
        return (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00;
    }

    @Nullable
    static int[] parseIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] out = new int[4];
        for (int i = 0; i < 4; i++) {
            String p = parts[i];
            if (p.isEmpty() || p.length() > 3) return null;
            for (int j = 0; j < p.length(); j++) if (p.charAt(j) < '0' || p.charAt(j) > '9') return null;
            int v = Integer.parseInt(p);
            if (v > 255) return null;
            out[i] = v;
        }
        return out;
    }

    /** Eight 16-bit groups, or null. Zone ids and embedded IPv4 are rejected. */
    @Nullable
    static int[] parseIpv6(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.indexOf('%') >= 0 || h.indexOf('.') >= 0 || h.length() > 45) return null;
        for (int i = 0; i < h.length(); i++) {
            char c = h.charAt(i);
            if (c != ':' && (c < '0' || c > '9') && (c < 'a' || c > 'f')) return null;
        }
        int gap = h.indexOf("::");
        if (gap >= 0 && h.indexOf("::", gap + 1) >= 0) return null;
        String head = gap >= 0 ? h.substring(0, gap) : h;
        String tail = gap >= 0 ? h.substring(gap + 2) : "";
        String[] headGroups = head.isEmpty() ? new String[0] : head.split(":", -1);
        String[] tailGroups = tail.isEmpty() ? new String[0] : tail.split(":", -1);
        int total = headGroups.length + tailGroups.length;
        if (gap < 0 ? total != 8 : total > 7) return null;
        int[] out = new int[8];
        int idx = 0;
        for (String g : headGroups) { if (!validGroup(g)) return null; out[idx++] = Integer.parseInt(g, 16); }
        idx = 8 - tailGroups.length;
        for (String g : tailGroups) { if (!validGroup(g)) return null; out[idx++] = Integer.parseInt(g, 16); }
        return out;
    }

    private static boolean validGroup(String g) {
        return !g.isEmpty() && g.length() <= 4;
    }
}
