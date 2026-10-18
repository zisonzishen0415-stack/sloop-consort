// SPDX-License-Identifier: GPL-3.0-only
// The phone's half of the library: list what is in Download/SLOOP (and song files found in Download),
// read one back, import one into Download/SLOOP, share it through the system sheet, rename it, delete it,
// or open it in another app. The page asks for a name and its folder; the MediaStore row does the work.
package app.consort;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class FilesBridge {
    private static final String ROOT = Environment.DIRECTORY_DOWNLOADS;        /* "Download" */
    private static final String DIR = ROOT + "/SLOOP";
    private final Activity activity;
    private final Handler ui = new Handler(Looper.getMainLooper());

    public FilesBridge(Activity activity) {
        this.activity = activity;
    }

    /** [{name, size, date, path, managed}] as JSON, newest first. */
    @JavascriptInterface
    public String list() {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        if (Build.VERSION.SDK_INT >= 29) {
            // Everything the app owns (backups, imported songs, takes), plus song files the user
            // downloaded elsewhere. MediaStore may hide other apps' rows on newer Androids; the
            // import button is the reliable path in that case.
            first = listInto(sb, first, MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                    new String[]{DIR + "/%"}, true);
            first = listInto(sb, first, MediaStore.MediaColumns.RELATIVE_PATH + " = ? AND ("
                            + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ? OR "
                            + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ? OR "
                            + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?)",
                    new String[]{ROOT + "/", "%.sloopsong", "%.sloopset", "SLOOP-backup-%.json"}, false);
        } else {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File[] files = dir != null ? dir.listFiles() : null;
            List<File> out = new ArrayList<>();
            if (files != null) for (File f : files) if (f.isFile()) out.add(f);
            java.util.Collections.sort(out, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File f : out) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"name\":\"").append(esc(f.getName())).append("\",\"size\":").append(f.length())
                        .append(",\"date\":").append(f.lastModified() / 1000)
                        .append(",\"path\":\"\",\"managed\":true}");
            }
        }
        return sb.append(']').toString();
    }

    private boolean listInto(StringBuilder sb, boolean first, String selection, String[] args, boolean managed) {
        String[] cols = {MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.RELATIVE_PATH};
        try (Cursor c = activity.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cols,
                selection, args, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(0);
                if (name == null) continue;
                if (!first) sb.append(',');
                first = false;
                String rel = c.getString(3);
                sb.append("{\"name\":\"").append(esc(name)).append("\",\"size\":").append(c.getLong(1))
                        .append(",\"date\":").append(c.getLong(2))
                        .append(",\"path\":\"").append(esc(rel == null ? "" : rel)).append("\"")
                        .append(",\"managed\":").append(managed).append('}');
            }
        } catch (Exception ignored) {
        }
        return first;
    }

    /** The whole file as UTF-8, or null when it cannot be opened (JSON song and backup files). */
    @JavascriptInterface
    public String readText(String name, String path) {
        try {
            InputStream in;
            if (Build.VERSION.SDK_INT < 29) {
                // Our own directory: read it directly, so a file MediaStore has not indexed still opens.
                in = new FileInputStream(new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safeName(name)));
            } else {
                Uri uri = uriFor(name, path);
                if (uri == null) return null;
                in = activity.getContentResolver().openInputStream(uri);
            }
            if (in == null) return null;
            try (InputStream input = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** The whole file as base64, so the sampler can decode a saved WAV take back into the editor. */
    @JavascriptInterface
    public String readBase64(String name, String path) {
        try {
            InputStream in;
            if (Build.VERSION.SDK_INT < 29) {
                in = new FileInputStream(new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safeName(name)));
            } else {
                Uri uri = uriFor(name, path);
                if (uri == null) return null;
                in = activity.getContentResolver().openInputStream(uri);
            }
            if (in == null) return null;
            try (InputStream input = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Copy a file found outside Download/SLOOP into it. Returns the stored name, or null. */
    @JavascriptInterface
    public String importToLibrary(String name, String path) {
        String clean = safeName(name);
        if (Build.VERSION.SDK_INT >= 29) {
            Uri src = uriFor(clean, path);
            if (src == null) return null;
            ContentResolver cr = activity.getContentResolver();
            String target = uniqueMediaName(cr, clean);
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, target);
            v.put(MediaStore.MediaColumns.MIME_TYPE, storeMime(clean));
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, DIR);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri dst;
            try {
                dst = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            } catch (Exception e) {
                return null;
            }
            if (dst == null) return null;
            try (InputStream in = cr.openInputStream(src);
                 OutputStream out = cr.openOutputStream(dst)) {
                if (in == null || out == null) throw new java.io.IOException("no stream");
                copy(in, out);
            } catch (Exception e) {
                cr.delete(dst, null, null);
                return null;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(dst, done, null, null);
            return target;
        }
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File from = new File(dir, clean);
        if (!from.isFile()) return null;
        File to = unique(dir, clean);
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            copy(in, out);
            MediaScannerConnection.scanFile(activity, new String[]{to.getAbsolutePath()}, null, null);
            return to.getName();
        } catch (Exception e) {
            return null;
        }
    }

    @JavascriptInterface
    public void share(String name) {
        shareAt(name, DIR + "/");
    }

    @JavascriptInterface
    public void shareAt(String name, String path) {
        Uri uri = uriFor(name, path);
        if (uri == null) { toast("找不到文件：" + name); return; }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime(name));
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, name);
        send.setClipData(android.content.ClipData.newRawUri(name, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ui.post(() -> {
            try {
                activity.startActivity(Intent.createChooser(send, "分享 " + name));
            } catch (Exception e) {
                toast("没有可以分享的应用");
            }
        });
    }

    /** Share generated text (a canonical song, a playlist) without adding it to the library. */
    @JavascriptInterface
    public boolean shareText(String name, String text, String type) {
        if (text == null) return false;
        String clean = safeName(name);
        File dir = new File(activity.getCacheDir(), "share");
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        File f = new File(dir, clean);
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
        // The receiver reads the file when it starts; older copies can go.
        File[] old = dir.listFiles();
        if (old != null) for (File x : old) {
            if (!x.getName().equals(clean) && System.currentTimeMillis() - x.lastModified() > 3600000L) x.delete();
        }
        Uri uri = Uri.parse("content://" + ShareProvider.AUTHORITY + "/" + Uri.encode(clean));
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(type == null || type.isEmpty() ? mime(clean) : type);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, clean);
        send.setClipData(android.content.ClipData.newUri(activity.getContentResolver(), clean, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ui.post(() -> {
            try {
                activity.startActivity(Intent.createChooser(send, "分享 " + clean));
            } catch (Exception e) {
                toast("没有可以分享的应用");
            }
        });
        return true;
    }

    @JavascriptInterface
    public boolean openWith(String name, String path) {
        Uri uri = uriFor(name, path);
        if (uri == null) return false;
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, mime(name));
        view.setClipData(android.content.ClipData.newRawUri(name, uri));
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // No resolveActivity() here: on Android 11+ package visibility would make every file look unopenable.
        ui.post(() -> {
            try {
                activity.startActivity(view);
            } catch (Exception e) {
                toast("没有可以打开它的应用");
            }
        });
        return true;
    }

    /** The build stamp from the manifest, so About can say which APK is installed. */
    @JavascriptInterface
    public String version() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean rename(String name, String to) {
        return renameAt(name, DIR + "/", to);
    }

    @JavascriptInterface
    public boolean renameAt(String name, String path, String to) {
        if (name == null) return false;
        String clean = to == null ? "" : to.trim().replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_");
        if (clean.isEmpty()) return false;
        String oldExt = ext(name);
        if (!oldExt.isEmpty() && !clean.toLowerCase(Locale.ROOT).endsWith("." + oldExt)) clean += "." + oldExt;
        if (clean.equals(name)) return true;
        if (Build.VERSION.SDK_INT >= 29) {
            Uri uri = uriFor(name, path);
            if (uri == null || mediaNameExists(clean, path)) return false;   // never overwrite another file
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, clean);
            try {
                return activity.getContentResolver().update(uri, v, null, null) > 0;
            } catch (Exception e) {
                return false;                         // a file another app owns: import it first
            }
        }
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File from = new File(dir, safeName(name)), dest = new File(dir, clean);
        boolean ok = from.isFile() && !dest.exists() && from.renameTo(dest);
        if (ok) MediaScannerConnection.scanFile(activity,
                new String[]{from.getAbsolutePath(), dest.getAbsolutePath()}, null, null);
        return ok;
    }

    @JavascriptInterface
    public boolean delete(String name) {
        return deleteAt(name, DIR + "/");
    }

    @JavascriptInterface
    public boolean deleteAt(String name, String path) {
        if (Build.VERSION.SDK_INT >= 29) {
            Uri uri = uriFor(name, path);
            if (uri == null) return false;
            try {
                return activity.getContentResolver().delete(uri, null, null) > 0;
            } catch (Exception e) {
                return false;
            }
        }
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File f = new File(dir, safeName(name));
        boolean ok = f.isFile() && f.delete();
        if (ok) MediaScannerConnection.scanFile(activity, new String[]{f.getAbsolutePath()}, null, null);
        return ok;
    }

    private boolean mediaNameExists(String name, String path) {
        try (Cursor c = activity.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                new String[]{name, normDir(path) + "%"}, null)) {
            return c != null && c.moveToFirst();
        } catch (Exception e) {
            return true;                              // unknown: never risk an overwrite
        }
    }

    private Uri uriFor(String name, String path) {
        if (Build.VERSION.SDK_INT >= 29) {
            try (Cursor c = activity.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.MediaColumns._ID},
                    MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                    new String[]{name, normDir(path) + "%"}, null)) {
                if (c != null && c.moveToFirst())
                    return ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
            } catch (Exception ignored) {
            }
            return null;
        }
        return uriForLegacy(name);
    }

    private static String normDir(String path) {
        String rel = path == null ? "" : path.trim();
        if (rel.isEmpty()) rel = DIR;
        if (!rel.endsWith("/")) rel += "/";
        return rel;
    }

    private Uri uriForLegacy(String name) {
        File f = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safeName(name));
        try (Cursor c = activity.getContentResolver().query(MediaStore.Files.getContentUri("external"),
                new String[]{MediaStore.Files.FileColumns._ID},
                MediaStore.Files.FileColumns.DATA + "=?", new String[]{f.getAbsolutePath()}, null)) {
            if (c != null && c.moveToFirst())
                return ContentUris.withAppendedId(MediaStore.Files.getContentUri("external"), c.getLong(0));
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String uniqueMediaName(ContentResolver cr, String name) {
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        String candidate = name;
        for (int i = 1; i < 1000; i++) {
            if (!mediaNameExists(cr, candidate)) return candidate;
            candidate = base + " (" + i + ")" + ext;
        }
        return base + " (" + System.currentTimeMillis() + ")" + ext;
    }

    private static boolean mediaNameExists(ContentResolver cr, String name) {
        try (Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                new String[]{name, DIR + "/%"}, null)) {
            return c != null && c.moveToFirst();
        } catch (Exception e) {
            return false;
        }
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static String safeName(String name) {
        if (name == null) name = "";
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "sloop-export";
        return name;
    }

    private static String ext(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1) : "";
    }

    private static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".json") || n.endsWith(".sloopsong") || n.endsWith(".sloopset")) return "application/json";
        if (n.endsWith(".mid")) return "audio/midi";
        return "application/octet-stream";
    }

    /** MediaStore appends the extension its MIME type names; octet-stream keeps a .sloopsong as it is. */
    private static String storeMime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }

    private static String esc(String s) {
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': b.append("\\\\"); break;
                case '"': b.append("\\\""); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    private void toast(String m) {
        ui.post(() -> Toast.makeText(activity, m, Toast.LENGTH_LONG).show());
    }
}
