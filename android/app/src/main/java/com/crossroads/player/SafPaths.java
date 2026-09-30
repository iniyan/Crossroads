package com.crossroads.player;

/**
 * Maps between the absolute paths MediaStore reports (DATA column, e.g.
 * /storage/emulated/0/Music/Album/01.flac) and Storage Access Framework document ids of
 * the external-storage provider ("primary:Music/Album/01.flac", "1234-5678:Music/...").
 *
 * Pure Java so the mapping is unit-tested on the JVM; the plugin supplies the primary
 * volume's path from Environment.getExternalStorageDirectory().
 */
final class SafPaths {

    static final String EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents";
    static final String DEFAULT_PRIMARY_ROOT = "/storage/emulated/0";

    private SafPaths() {}

    /**
     * The file-system directory a tree document id points at, or null when the id belongs
     * to a volume this mapping does not understand.
     *
     * @param treeDocumentId e.g. "primary:Music", "primary:", "1234-5678:Audio"
     * @param primaryRoot    e.g. "/storage/emulated/0"
     */
    static String treePath(String treeDocumentId, String primaryRoot) {
        if (treeDocumentId == null) return null;
        int colon = treeDocumentId.indexOf(':');
        if (colon < 0) return null;
        String volume = treeDocumentId.substring(0, colon);
        String rel = stripSlashes(treeDocumentId.substring(colon + 1));
        String base;
        if (volume.equals("primary")) {
            base = stripTrailingSlash(primaryRoot == null || primaryRoot.isEmpty() ? DEFAULT_PRIMARY_ROOT : primaryRoot);
        } else if (volume.equals("home")) {
            base = stripTrailingSlash(primaryRoot == null || primaryRoot.isEmpty() ? DEFAULT_PRIMARY_ROOT : primaryRoot) + "/Documents";
        } else if (volume.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}") || volume.matches("[A-Za-z0-9_-]+")) {
            base = "/storage/" + volume;
        } else {
            return null;
        }
        return rel.isEmpty() ? base : base + "/" + rel;
    }

    /** {@code path} relative to {@code root} (no leading slash), or null when it is not inside. */
    static String relativePath(String root, String path) {
        if (root == null || path == null) return null;
        String r = stripTrailingSlash(root);
        if (path.equals(r)) return "";
        if (!path.startsWith(r + "/")) return null;
        return path.substring(r.length() + 1);
    }

    /** The document id of {@code relative} inside the tree ("primary:Music" + "Album/x.flac" -> "primary:Music/Album/x.flac"). */
    static String childDocumentId(String treeDocumentId, String relative) {
        if (treeDocumentId == null) return null;
        String rel = stripSlashes(relative == null ? "" : relative);
        if (rel.isEmpty()) return treeDocumentId;
        int colon = treeDocumentId.indexOf(':');
        String treeRel = colon < 0 ? "" : stripSlashes(treeDocumentId.substring(colon + 1));
        String prefix = colon < 0 ? treeDocumentId + ":" : treeDocumentId.substring(0, colon + 1);
        return prefix + (treeRel.isEmpty() ? rel : treeRel + "/" + rel);
    }

    /** The document id of the directory holding {@code documentId} (null at the volume root). */
    static String parentDocumentId(String documentId) {
        if (documentId == null) return null;
        int colon = documentId.indexOf(':');
        int slash = documentId.lastIndexOf('/');
        if (slash < 0 || slash < colon) return colon < 0 ? null : documentId.substring(0, colon + 1);
        return documentId.substring(0, slash);
    }

    /** The last path segment of an absolute path or document id. */
    static String fileName(String pathOrId) {
        if (pathOrId == null) return "";
        int slash = pathOrId.lastIndexOf('/');
        int colon = pathOrId.indexOf(':');
        int cut = Math.max(slash, slash < 0 && colon >= 0 ? colon : -1);
        return cut < 0 ? pathOrId : pathOrId.substring(cut + 1);
    }

    /** {@code name} with its extension replaced by {@code extension} (".lrc"). */
    static String withExtension(String name, String extension) {
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        return base + extension;
    }

    private static String stripSlashes(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && s.charAt(start) == '/') start++;
        while (end > start && s.charAt(end - 1) == '/') end--;
        return s.substring(start, end);
    }

    private static String stripTrailingSlash(String s) {
        int end = s.length();
        while (end > 1 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
